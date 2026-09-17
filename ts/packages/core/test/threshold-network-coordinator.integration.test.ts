import { describe, expect, it } from "vitest";
import { createThresholdIdentity } from "../src/adapters/threshold-identity.js";
import { createThresholdNetworkCoordinator } from "../src/adapters/threshold-network-coordinator.js";
import { startThresholdParticipant } from "../src/adapters/threshold-participant.js";
import { createMemoryNonceStore } from "../src/adapters/memory-nonce-store.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import type {
  ManageCommand,
  CapabilityScope,
  DeviceId,
} from "../src/generated/protocol.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "../src/domain/mesh-session.js";
import { mintCapabilityToken } from "../src/domain/tokens.js";
import { deriveDeviceId } from "../src/adapters/node-identity.js";
import {
  toBeSigned,
  type ThresholdSubject,
} from "../src/domain/threshold-subject.js";
import {
  dkgRound1,
  dkgRound2,
  dkgRound3,
  type DeviceKeyed,
} from "../src/adapters/threshold-wasm.js";
import {
  fixedClock,
  generateEd25519Identity,
  neverRevoked,
  nextTokenId,
} from "./tokens-fixtures.js";

const DEVICE_ID_LENGTH = 32;
const THRESHOLD = 2;
const PARTICIPANTS = 3;
const SIGN_DEADLINE_MS = 60_000;
const NOW_MS = 1_000_000;
const HOUR_MS = 3_600_000;
const EXPIRES_MS = NOW_MS + HOUR_MS;
const THIRD_DEVICE_BYTE = 3;

function deviceId(byte: number): DeviceId {
  const bytes = new Uint8Array(DEVICE_ID_LENGTH);
  bytes[DEVICE_ID_LENGTH - 1] = byte;
  return bytes;
}

function sameDeviceId(a: DeviceId, b: DeviceId): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

function hexOf(id: DeviceId): string {
  return Buffer.from(id).toString("hex");
}

interface DkgParticipant {
  deviceId: DeviceId;
  round3: ReturnType<typeof dkgRound3>;
}

/** Runs a fresh T=2-of-3 DKG entirely through the wasm bindings -- the same fixture threshold-identity.unit.test.ts's own inProcessCoordinator test uses, kept local for the identical reason that test states: these tests build a real coordinator/participant pair directly on top of it. */
function runDkg(deviceIds: readonly DeviceId[]): DkgParticipant[] {
  const round1ByDevice = deviceIds.map((id) => ({
    deviceId: id,
    ...dkgRound1(id, PARTICIPANTS, THRESHOLD),
  }));
  const round1Entries: DeviceKeyed[] = round1ByDevice.map((p) => ({
    deviceId: p.deviceId,
    value: p.package,
  }));

  const round2ByDevice = round1ByDevice.map((p) => {
    const othersRound1 = round1Entries.filter(
      (e) => !sameDeviceId(e.deviceId, p.deviceId),
    );
    return {
      deviceId: p.deviceId,
      ...dkgRound2(p.secretPackage, othersRound1),
    };
  });

  const inboxes = new Map<string, DeviceKeyed[]>(
    deviceIds.map((id) => [hexOf(id), []]),
  );
  for (const sender of round2ByDevice) {
    for (const { deviceId: recipient, value } of sender.outgoing) {
      const inbox = inboxes.get(hexOf(recipient));
      if (!inbox) {
        throw new Error("test fixture: unknown DKG recipient");
      }
      inbox.push({ deviceId: sender.deviceId, value });
    }
  }

  return round2ByDevice.map((p) => {
    const othersRound1 = round1Entries.filter(
      (e) => !sameDeviceId(e.deviceId, p.deviceId),
    );
    const inbox = inboxes.get(hexOf(p.deviceId));
    if (!inbox) {
      throw new Error("test fixture: missing DKG inbox");
    }
    return {
      deviceId: p.deviceId,
      round3: dkgRound3(p.secretPackage, othersRound1, inbox),
    };
  });
}

/** A minimal in-process request/response bus satisfying exactly the two MeshSession slices createThresholdNetworkCoordinator and startThresholdParticipant each depend on -- real manage-request/manage-response round trips, just with no real transport underneath, so the SAME production coordinator/participant code this test exercises is what a real MeshSession would run. */
function createFakeBus(): {
  coordinatorSession: Pick<MeshSession, "sendManageRequest">;
  participantSessionFor: (
    device: DeviceId,
  ) => Pick<MeshSession, "incomingManageRequests">;
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
    coordinatorSession: {
      sendManageRequest: async (
        command: ManageCommand,
        scope: Readonly<CapabilityScope>,
        targetDevice?: DeviceId,
        token?: IncomingManageRequest["token"],
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
            ...(token !== undefined ? { token } : {}),
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
    },
    participantSessionFor: (device: DeviceId) => ({
      incomingManageRequests: {
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<IncomingManageRequest>> =>
              new Promise((resolve) => {
                const inbox = inboxFor(deviceIdToHex(device));
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

describe("threshold-network-coordinator + threshold-participant: real manage-request round trip", () => {
  it("signSubject produces a group signature via real network-shaped commit/sign traffic", async () => {
    const root = await generateEd25519Identity();
    // The FROST identifier every DKG round derives is Identifier::derive(device-id) (identifiers.rs) -- this MUST be each signer's own real personal device-id, the same one it later signs threshold-share-envelopes under, not a placeholder. The third participant plays no signing role in this T=2 test, so it stays a synthetic filler device-id.
    const personalA = await generateEd25519Identity();
    const personalB = await generateEd25519Identity();
    const ids = [
      personalA.deviceId,
      personalB.deviceId,
      deviceId(THIRD_DEVICE_BYTE),
    ];
    const participants = runDkg(ids);
    const [first, second] = participants;
    if (!first || !second) {
      throw new Error("test fixture: expected at least two DKG participants");
    }
    const group = first.round3.groupVerifyingKey;
    const groupDeviceId = await deriveDeviceId(group);

    const signers = [
      { dkg: first, personal: personalA },
      { dkg: second, personal: personalB },
    ];

    const clock = fixedClock(NOW_MS);
    const mint = await mintCapabilityToken({
      identity: root,
      clock,
      tokenId: nextTokenId(),
      bearer: personalA.deviceId,
      capability: "exadev.io/threshold:sign",
      scope: { kind: "group" },
      expires: EXPIRES_MS,
    });
    if (!mint.ok) {
      throw new Error(`test fixture: token mint failed: ${mint.reason}`);
    }
    const token = mint.token;

    const bus = createFakeBus();
    for (const { dkg, personal } of signers) {
      startThresholdParticipant({
        session: bus.participantSessionFor(personal.deviceId),
        personalIdentity: personal,
        keyPackagesByGroup: new Map([
          [deviceIdToHex(groupDeviceId), dkg.round3.keyPackage],
        ]),
        nonceStore: createMemoryNonceStore(),
        clock,
        revocation: neverRevoked,
      });
    }

    const coordinator = createThresholdNetworkCoordinator({
      session: bus.coordinatorSession,
      group: groupDeviceId,
      verifierIdentity: root,
      token,
    });

    const identity = await createThresholdIdentity(
      group,
      first.round3.publicKeyPackage,
      THRESHOLD,
      signers.map((s) => s.personal.deviceId),
      coordinator,
    );

    const subject: ThresholdSubject = {
      kind: "capability-token",
      protected: new Uint8Array([1, 2, 1]),
      payload: new Uint8Array([1, 2, 2]),
    };

    const signature = await identity.signSubject(
      subject,
      clock.now() + SIGN_DEADLINE_MS,
    );

    const ok = await identity.verify(
      identity.identityKey,
      toBeSigned(subject),
      signature,
    );
    expect(ok).toBe(true);
  });
});
