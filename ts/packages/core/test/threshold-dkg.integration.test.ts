import { describe, expect, it } from "vitest";
import { runFreshThresholdDkg } from "../src/adapters/threshold-dkg.js";
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
  signingBuildPackage,
  signingRound1Commit,
  signingRound2Sign,
  signingAggregate,
  type DeviceKeyed,
} from "../src/adapters/threshold-wasm.js";
import {
  deriveDeviceId,
  verifyWithPublicKey,
} from "../src/adapters/node-identity.js";

const DEVICE_ID_LENGTH = 32;
const THRESHOLD = 2;
const SECOND_DEVICE_BYTE = 2;
const THIRD_DEVICE_BYTE = 3;
const SESSION_ID = 1n;
const ALG_ED25519 = -8;

function deviceId(byte: number): DeviceId {
  const bytes = new Uint8Array(DEVICE_ID_LENGTH);
  bytes[DEVICE_ID_LENGTH - 1] = byte;
  return bytes;
}

/** A relay-shaped in-process bus: every device shares ONE addressable inbox, and every delivered manage-request carries the sender's own device-id as `fromDevice` -- the same shape a real relay-routed MeshSession produces (mesh-session.ts's own applyManageRequest(frame, viaRelay=true) path), which runFreshThresholdDkg's own choreography depends on to disambiguate more than one concurrent peer. */
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

describe("threshold-dkg: runFreshThresholdDkg", () => {
  it("three devices derive the identical group key via real network-shaped round1/round2/confirm traffic, and the resulting key packages actually sign", async () => {
    const alice = deviceId(1);
    const bob = deviceId(SECOND_DEVICE_BYTE);
    const carol = deviceId(THIRD_DEVICE_BYTE);
    const bus = createRelayBus();

    const [aliceResult, bobResult, carolResult] = await Promise.all([
      runFreshThresholdDkg({
        session: bus.sessionFor(alice),
        ownDeviceId: alice,
        otherParticipants: [bob, carol],
        threshold: THRESHOLD,
        sessionId: SESSION_ID,
      }),
      runFreshThresholdDkg({
        session: bus.sessionFor(bob),
        ownDeviceId: bob,
        otherParticipants: [alice, carol],
        threshold: THRESHOLD,
        sessionId: SESSION_ID,
      }),
      runFreshThresholdDkg({
        session: bus.sessionFor(carol),
        ownDeviceId: carol,
        otherParticipants: [alice, bob],
        threshold: THRESHOLD,
        sessionId: SESSION_ID,
      }),
    ]);

    expect(
      deviceIdToHex(await deriveDeviceId(aliceResult.groupVerifyingKey)),
    ).toBe(deviceIdToHex(await deriveDeviceId(bobResult.groupVerifyingKey)));
    expect(bobResult.groupVerifyingKey).toEqual(carolResult.groupVerifyingKey);
    expect(aliceResult.groupVerifyingKey).toEqual(bobResult.groupVerifyingKey);

    // The DKG's own output key packages must be real, usable FROST shares: T=2 of Alice/Bob actually sign, and the aggregate verifies against the group verifying key with ordinary Web Crypto, zero verifier change.
    const message = new TextEncoder().encode("dkg produced a real key");
    const aliceCommit = signingRound1Commit(aliceResult.keyPackage);
    const bobCommit = signingRound1Commit(bobResult.keyPackage);
    const commitEntries: DeviceKeyed[] = [
      { deviceId: alice, value: aliceCommit.commitments },
      { deviceId: bob, value: bobCommit.commitments },
    ];
    const signingPackage = signingBuildPackage(commitEntries, message);
    const shares: DeviceKeyed[] = [
      {
        deviceId: alice,
        value: signingRound2Sign(
          aliceCommit.nonces,
          signingPackage,
          aliceResult.keyPackage,
        ),
      },
      {
        deviceId: bob,
        value: signingRound2Sign(
          bobCommit.nonces,
          signingPackage,
          bobResult.keyPackage,
        ),
      },
    ];
    const signature = signingAggregate(
      signingPackage,
      shares,
      aliceResult.publicKeyPackage,
    );
    const ok = await verifyWithPublicKey(
      { alg: ALG_ED25519, "public-key": aliceResult.groupVerifyingKey },
      message,
      signature,
    );
    expect(ok).toBe(true);
  });
});
