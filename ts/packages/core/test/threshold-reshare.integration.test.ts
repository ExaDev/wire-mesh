import { describe, expect, it } from "vitest";
import {
  computeReshareContribution,
  joinThresholdReshare,
  runFreshThresholdDkg,
  sendReshareContribution,
} from "../src/adapters/threshold-dkg.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import type {
  CapabilityScope,
  DeviceId,
  ManageCommand,
} from "../src/generated/protocol.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "../src/domain/mesh-session.js";
import {
  signingAggregate,
  signingBuildPackage,
  signingRound1Commit,
  signingRound2Sign,
  type DeviceKeyed,
} from "../src/adapters/threshold-wasm.js";
import { verifyWithPublicKey } from "../src/adapters/node-identity.js";

const DEVICE_ID_LENGTH = 32;
const THRESHOLD = 2;
const SECOND_DEVICE_BYTE = 2;
const THIRD_DEVICE_BYTE = 3;
const FOURTH_DEVICE_BYTE = 4;
const DKG_SESSION_ID = 1n;
const RESHARE_SESSION_ID = 2n;
const ALG_ED25519 = -8;

function deviceId(byte: number): DeviceId {
  const bytes = new Uint8Array(DEVICE_ID_LENGTH);
  bytes[DEVICE_ID_LENGTH - 1] = byte;
  return bytes;
}

/** The same relay-shaped in-process bus threshold-dkg.integration.test.ts uses, kept local for the identical reason: real fromDevice-carrying manage-request round trips, no real transport underneath. */
function createRelayBus(): {
  sessionFor: (
    device: DeviceId,
  ) => Pick<MeshSession, "sendManageRequest" | "incomingManageRequests">;
} {
  interface Inbox {
    waiters: ((request: IncomingManageRequest) => void)[];
    backlog: IncomingManageRequest[];
  }
  const inboxes = new Map<string, Inbox>();
  let nextRequestId = 0;

  function inboxFor(hex: string): Inbox {
    let inbox = inboxes.get(hex);
    if (inbox === undefined) {
      inbox = { waiters: [], backlog: [] };
      inboxes.set(hex, inbox);
    }
    return inbox;
  }

  return {
    sessionFor: (self: DeviceId) => ({
      sendManageRequest: async (
        command: ManageCommand,
        scope: Readonly<CapabilityScope>,
        targetDevice?: DeviceId,
      ): Promise<ManageOutcome> => {
        if (targetDevice === undefined) {
          throw new Error("test bus requires an explicit targetDevice");
        }
        const requestId = nextRequestId;
        nextRequestId += 1;
        return new Promise<ManageOutcome>((resolve) => {
          const incoming: IncomingManageRequest = {
            requestId,
            command,
            scope,
            fromDevice: self,
            respond: async (outcome: ManageOutcome): Promise<void> => {
              resolve(outcome);
              return Promise.resolve();
            },
          };
          const inbox = inboxFor(deviceIdToHex(targetDevice));
          const waiter = inbox.waiters.shift();
          if (waiter) {
            waiter(incoming);
          } else {
            inbox.backlog.push(incoming);
          }
        });
      },
      incomingManageRequests: {
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<IncomingManageRequest>> =>
              new Promise((resolve) => {
                const inbox = inboxFor(deviceIdToHex(self));
                const backlogItem = inbox.backlog.shift();
                if (backlogItem) {
                  resolve({ value: backlogItem, done: false });
                } else {
                  inbox.waiters.push((request) => {
                    resolve({ value: request, done: false });
                  });
                }
              }),
          };
        },
      },
    }),
  };
}

describe("threshold-dkg: contributeThresholdReshare + joinThresholdReshare", () => {
  it("reshares a T=2-of-3 group to a different T=2-of-3 committee (one device dropped, one added), preserving the group key and producing shares that actually sign", async () => {
    const alice = deviceId(1);
    const bob = deviceId(SECOND_DEVICE_BYTE);
    const carol = deviceId(THIRD_DEVICE_BYTE); // leaving
    const dave = deviceId(FOURTH_DEVICE_BYTE); // joining

    const dkgBus = createRelayBus();
    // carol's own DKG result is intentionally unused past this point -- she is the survivor who leaves in the reshare below and never runs joinThresholdReshare.
    const [aliceDkg, bobDkg] = await Promise.all([
      runFreshThresholdDkg({
        session: dkgBus.sessionFor(alice),
        ownDeviceId: alice,
        otherParticipants: [bob, carol],
        threshold: THRESHOLD,
        sessionId: DKG_SESSION_ID,
      }),
      runFreshThresholdDkg({
        session: dkgBus.sessionFor(bob),
        ownDeviceId: bob,
        otherParticipants: [alice, carol],
        threshold: THRESHOLD,
        sessionId: DKG_SESSION_ID,
      }),
      runFreshThresholdDkg({
        session: dkgBus.sessionFor(carol),
        ownDeviceId: carol,
        otherParticipants: [alice, bob],
        threshold: THRESHOLD,
        sessionId: DKG_SESSION_ID,
      }),
    ]);
    const originalGroupKey = aliceDkg.groupVerifyingKey;

    // Reshare: alice and bob (survivors) hand off to alice, bob, dave (carol drops, dave joins) -- still T=2.
    const survivors = [alice, bob];
    const newParticipants = [alice, bob, dave];
    const reshareBus = createRelayBus();

    // A survivor that is ALSO staying in newParticipants must start its own joinThresholdReshare (which begins listening immediately) CONCURRENTLY with sendReshareContribution's own broadcast sends -- awaiting the sends to finish before starting to listen would deadlock against every other survivor doing the identical thing, each waiting for the other's consume loop to start before its own send can be acknowledged. Only computeReshareContribution (synchronous, no I/O) is a real dependency joinThresholdReshare needs before it can start.
    async function survivorFlow(
      self: DeviceId,
      ownOldKeyPackage: Uint8Array,
      otherSurvivors: readonly DeviceId[],
    ) {
      const baseOptions = {
        session: reshareBus.sessionFor(self),
        ownDeviceId: self,
        survivors,
        newParticipants,
        newThreshold: THRESHOLD,
        existingGroupKey: originalGroupKey,
        sessionId: RESHARE_SESSION_ID,
      };
      const contribution = computeReshareContribution({
        ...baseOptions,
        ownOldKeyPackage,
      });
      const [, joinResult] = await Promise.all([
        sendReshareContribution(
          { ...baseOptions, ownOldKeyPackage },
          contribution,
        ),
        joinThresholdReshare({
          ...baseOptions,
          otherSurvivors,
          ...(contribution.shareToSelf !== undefined
            ? {
                ownContribution: {
                  commitment: contribution.commitment,
                  shareToSelf: contribution.shareToSelf,
                },
              }
            : {}),
        }),
      ]);
      return joinResult;
    }

    const [aliceResult, bobResult, daveResult] = await Promise.all([
      survivorFlow(alice, aliceDkg.keyPackage, [bob]).catch((e: unknown) => {
        console.error("ALICE FLOW FAILED", e);
        throw e;
      }),
      survivorFlow(bob, bobDkg.keyPackage, [alice]).catch((e: unknown) => {
        console.error("BOB FLOW FAILED", e);
        throw e;
      }),
      joinThresholdReshare({
        session: reshareBus.sessionFor(dave),
        ownDeviceId: dave,
        otherSurvivors: survivors,
        newParticipants,
        newThreshold: THRESHOLD,
        existingGroupKey: originalGroupKey,
        sessionId: RESHARE_SESSION_ID,
      }).catch((e: unknown) => {
        console.error("DAVE FLOW FAILED", e);
        throw e;
      }),
    ]);

    // Carol never ran joinThresholdReshare -- she is not in newParticipants and correctly has no result.
    expect(aliceResult.groupVerifyingKey).toEqual(originalGroupKey);
    expect(bobResult.groupVerifyingKey).toEqual(originalGroupKey);
    expect(daveResult.groupVerifyingKey).toEqual(originalGroupKey);

    // T=2 of Bob/Dave (neither of whom held a share together before the reshare) actually sign, and the aggregate verifies against the SAME group key with ordinary Web Crypto.
    const message = new TextEncoder().encode("reshare produced real shares");
    const bobCommit = signingRound1Commit(bobResult.keyPackage);
    const daveCommit = signingRound1Commit(daveResult.keyPackage);
    const commitEntries: DeviceKeyed[] = [
      { deviceId: bob, value: bobCommit.commitments },
      { deviceId: dave, value: daveCommit.commitments },
    ];
    const signingPackage = signingBuildPackage(commitEntries, message);
    const shares: DeviceKeyed[] = [
      {
        deviceId: bob,
        value: signingRound2Sign(
          bobCommit.nonces,
          signingPackage,
          bobResult.keyPackage,
        ),
      },
      {
        deviceId: dave,
        value: signingRound2Sign(
          daveCommit.nonces,
          signingPackage,
          daveResult.keyPackage,
        ),
      },
    ];
    const signature = signingAggregate(
      signingPackage,
      shares,
      bobResult.publicKeyPackage,
    );
    const ok = await verifyWithPublicKey(
      { alg: ALG_ED25519, "public-key": originalGroupKey },
      message,
      signature,
    );
    expect(ok).toBe(true);
  });
});
