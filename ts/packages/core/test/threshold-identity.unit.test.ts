import { describe, expect, it } from "vitest";
import type { DeviceId } from "../src/generated/protocol.js";
import {
  createThresholdIdentity,
  type SignatureShareEntry,
  type SigningCommitmentEntry,
  type ThresholdCoordinator,
} from "../src/adapters/threshold-identity.js";
import {
  toBeSigned,
  type ThresholdSubject,
} from "../src/domain/threshold-subject.js";
import {
  dkgRound1,
  dkgRound2,
  dkgRound3,
  signingBuildPackage,
  signingRound1Commit,
  signingRound2Sign,
  type DeviceKeyed,
} from "../src/adapters/threshold-wasm.js";

const DEVICE_ID_LENGTH = 32;
const THRESHOLD = 2;
const PARTICIPANTS = 3;
const ALG_ED25519 = -8;
const THIRD_DEVICE_BYTE = 3;
const SIGN_DEADLINE_MS = 60_000;
// Arbitrary, fixed byte fixtures -- this test exercises the signing infrastructure, not COSE encoding correctness, so the exact byte values are opaque fixture data, not a real cose-token-headers/token-claims encoding.
const SAMPLE_PROTECTED_HEADER = new Uint8Array([1, 2, 1]);
const SAMPLE_PAYLOAD = new Uint8Array([1, 2, 2]);
const ARBITRARY_MESSAGE = new Uint8Array([1, 2, 1]);

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

interface Participant {
  deviceId: DeviceId;
  round3: ReturnType<typeof dkgRound3>;
}

/** Runs a fresh T=2-of-3 DKG entirely through the wasm bindings -- the same fixture threshold-wasm.unit.test.ts uses, kept local since these tests build a coordinator directly on top of it. */
function runDkg(deviceIds: readonly DeviceId[]): Participant[] {
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
        throw new Error(
          "test fixture: round2 recipient is not one of the DKG's own participants",
        );
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
      throw new Error("test fixture: missing inbox for a DKG participant");
    }
    return {
      deviceId: p.deviceId,
      round3: dkgRound3(p.secretPackage, othersRound1, inbox),
    };
  });
}

interface SessionState {
  message: Uint8Array;
  noncesByDevice: Map<string, Uint8Array>;
}

/**
 * An in-process `ThresholdCoordinator`: simulates every participant's own device running the real wasm-backed round1/round2 crypto locally, exactly as a real coordinator would over the network, minus the network. Each simulated device independently re-derives the message it is signing from the `subject` it received on round 1 (`toBeSigned(subject)`) -- exactly the structural closure `spec/threshold.cddl` requires (round 2 never carries `subject`) -- rather than the coordinator dictating it.
 */
function inProcessCoordinator(
  participants: readonly Participant[],
): ThresholdCoordinator {
  const keyPackageByDevice = new Map(
    participants.map((p) => [hexOf(p.deviceId), p.round3.keyPackage]),
  );
  const sessions = new Map<string, SessionState>();

  return {
    async commitRound(
      sessionId,
      participantIds,
      subject,
    ): Promise<SigningCommitmentEntry[]> {
      const message = toBeSigned(subject);
      const noncesByDevice = new Map<string, Uint8Array>();
      const commitments: SigningCommitmentEntry[] = participantIds.map((id) => {
        const keyPackage = keyPackageByDevice.get(hexOf(id));
        if (!keyPackage) {
          throw new Error("test coordinator: unknown participant device-id");
        }
        const { nonces, commitments: commitmentBytes } =
          signingRound1Commit(keyPackage);
        noncesByDevice.set(hexOf(id), nonces);
        return { deviceId: id, value: commitmentBytes };
      });
      sessions.set(sessionId.toString(), { message, noncesByDevice });
      return Promise.resolve(commitments);
    },
    async signRound(sessionId, commitments): Promise<SignatureShareEntry[]> {
      const session = sessions.get(sessionId.toString());
      if (!session) {
        throw new Error(
          "test coordinator: signRound called for a session with no prior commitRound",
        );
      }
      const signingPackage = signingBuildPackage(commitments, session.message);

      const shares: SignatureShareEntry[] = commitments.map(
        ({ deviceId: id }) => {
          const keyPackage = keyPackageByDevice.get(hexOf(id));
          const nonces = session.noncesByDevice.get(hexOf(id));
          if (!keyPackage || !nonces) {
            throw new Error(
              "test coordinator: missing key package or nonces for a committed participant",
            );
          }
          session.noncesByDevice.delete(hexOf(id)); // one-shot, matching NonceStore.take's own contract
          return {
            deviceId: id,
            value: signingRound2Sign(nonces, signingPackage, keyPackage),
          };
        },
      );
      return Promise.resolve(shares);
    },
  };
}

describe("threshold-identity: createThresholdIdentity", () => {
  it("signSubject produces a signature the group's own identity verifies, via a full commit/sign round trip", async () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const participants = runDkg(ids);
    const [first] = participants;
    if (!first) {
      throw new Error("test fixture: expected at least one DKG participant");
    }

    const coordinator = inProcessCoordinator(participants);
    const identity = await createThresholdIdentity(
      first.round3.groupVerifyingKey,
      first.round3.publicKeyPackage,
      THRESHOLD,
      ids,
      coordinator,
    );

    expect(identity.deviceId.length).toBe(DEVICE_ID_LENGTH);
    expect(identity.identityKey.alg).toBe(ALG_ED25519);

    const subject: ThresholdSubject = {
      kind: "capability-token",
      protected: SAMPLE_PROTECTED_HEADER,
      payload: SAMPLE_PAYLOAD,
    };

    const signature = await identity.signSubject(
      subject,
      Date.now() + SIGN_DEADLINE_MS,
    );

    const ok = await identity.verify(
      identity.identityKey,
      toBeSigned(subject),
      signature,
    );
    expect(ok).toBe(true);
  });

  it("sign() always rejects -- signSubject is the only real entry point", async () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const participants = runDkg(ids);
    const [first] = participants;
    if (!first) {
      throw new Error("test fixture: expected at least one DKG participant");
    }
    const coordinator = inProcessCoordinator(participants);
    const identity = await createThresholdIdentity(
      first.round3.groupVerifyingKey,
      first.round3.publicKeyPackage,
      THRESHOLD,
      ids,
      coordinator,
    );

    await expect(identity.sign(ARBITRARY_MESSAGE)).rejects.toThrow(
      /signSubject/,
    );
  });

  it("rejects when fewer than the threshold number of participants commit", async () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const participants = runDkg(ids);
    const [first] = participants;
    if (!first) {
      throw new Error("test fixture: expected at least one DKG participant");
    }

    const underThreshold: ThresholdCoordinator = {
      commitRound: async () => Promise.resolve([]), // nobody committed
      signRound: async () => Promise.resolve([]),
    };
    const identity = await createThresholdIdentity(
      first.round3.groupVerifyingKey,
      first.round3.publicKeyPackage,
      THRESHOLD,
      ids,
      underThreshold,
    );

    const subject: ThresholdSubject = {
      kind: "capability-token",
      protected: new Uint8Array(),
      payload: new Uint8Array(),
    };
    await expect(
      identity.signSubject(subject, Date.now() + SIGN_DEADLINE_MS),
    ).rejects.toThrow(/committed/);
  });
});
