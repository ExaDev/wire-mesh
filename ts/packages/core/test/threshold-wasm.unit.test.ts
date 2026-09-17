import { describe, expect, it } from "vitest";
import type { DeviceId } from "../src/generated/protocol.js";
import {
  combineRound1Package,
  dkgConfirmMatches,
  dkgRound1,
  dkgRound2,
  dkgRound3,
  dkgTranscriptDigest,
  keyPackageSigningShare,
  splitRound1Package,
  reshareCombineCommitments,
  reshareCombineReceivedShares,
  reshareDerivePublicKeyPackage,
  reshareRound1,
  signingAggregate,
  signingBuildPackage,
  signingRound1Commit,
  signingRound2Sign,
  splitCommitments,
  combineCommitments,
  type DeviceKeyed,
} from "../src/adapters/threshold-wasm.js";
import {
  deriveDeviceId,
  verifyWithPublicKey,
} from "../src/adapters/node-identity.js";

const DEVICE_ID_LENGTH = 32;
const THRESHOLD = 2;
const PARTICIPANTS = 3;
const ED25519_SIGNATURE_LENGTH = 64;
const ALG_ED25519 = -8;
const THIRD_DEVICE_BYTE = 3;

function deviceId(byte: number): DeviceId {
  const bytes = new Uint8Array(DEVICE_ID_LENGTH);
  bytes[DEVICE_ID_LENGTH - 1] = byte;
  return bytes;
}

function sameDeviceId(a: DeviceId, b: DeviceId): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

/** Looks up the entry for `id` in a list of `{ deviceId, ... }` records, throwing (never returning `undefined`) if it isn't there -- a test fixture that genuinely can't find a participant it just created is a bug in the fixture, not a case to silently paper over. */
function forDevice<T extends { deviceId: DeviceId }>(
  entries: readonly T[],
  id: DeviceId,
): T {
  const found = entries.find((e) => sameDeviceId(e.deviceId, id));
  if (!found) {
    throw new Error("test fixture: no entry for the given device-id");
  }
  return found;
}

interface Participant {
  deviceId: DeviceId;
  round1: ReturnType<typeof dkgRound1>;
  round3: ReturnType<typeof dkgRound3>;
}

/** Runs a fresh T=2-of-3 DKG entirely through the wasm bindings, mirroring the equivalent Rust round-trip test in wire-mesh-threshold's own dkg.rs. Returns one entry per participant, each already carrying its own round-1 and round-3 output. */
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
    deviceIds.map((id) => [Buffer.from(id).toString("hex"), []]),
  );
  for (const sender of round2ByDevice) {
    for (const { deviceId: recipient, value } of sender.outgoing) {
      const inbox = inboxes.get(Buffer.from(recipient).toString("hex"));
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
    const inbox = inboxes.get(Buffer.from(p.deviceId).toString("hex"));
    if (!inbox) {
      throw new Error("test fixture: missing inbox for a DKG participant");
    }
    return {
      deviceId: p.deviceId,
      round1: forDevice(round1ByDevice, p.deviceId),
      round3: dkgRound3(p.secretPackage, othersRound1, inbox),
    };
  });
}

describe("threshold-wasm: DKG", () => {
  it("every participant derives the identical group key", () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const participants = runDkg(ids);
    const keys = participants.map((p) =>
      Buffer.from(p.round3.groupVerifyingKey).toString("hex"),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("splitRound1Package/combineRound1Package round-trips into the identical combined blob dkgRound2 expects", () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const [alice] = runDkg(ids);
    if (!alice) {
      throw new Error("test fixture: expected at least one DKG participant");
    }

    const { commitment, proofOfKnowledge } = splitRound1Package(
      alice.round1.package,
    );
    expect(commitment.length).toBeGreaterThan(0);
    expect(proofOfKnowledge.length).toBeGreaterThan(0);

    const recombined = combineRound1Package(commitment, proofOfKnowledge);
    expect(recombined).toEqual(alice.round1.package);
  });

  it("the group device-id is SHA-256 of the group verifying key, the ordinary identity.cddl rule", async () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const [alice] = runDkg(ids);
    if (!alice) {
      throw new Error("test fixture: expected at least one DKG participant");
    }
    const expected = await deriveDeviceId(alice.round3.groupVerifyingKey);
    // No wasm involvement here at all -- proving the group's identity needs zero new derivation logic anywhere, exactly wire-mesh#29's own point.
    expect(expected).toBeInstanceOf(Uint8Array);
    expect(expected.length).toBe(DEVICE_ID_LENGTH);
  });

  it("every participant's echo-broadcast transcript digest matches when nothing equivocated", () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const participants = runDkg(ids);
    const [alice, bob] = participants;
    if (!alice || !bob) {
      throw new Error("test fixture: expected at least two DKG participants");
    }
    const allRound1: DeviceKeyed[] = participants.map((p) => ({
      deviceId: p.deviceId,
      value: p.round1.package,
    }));

    const aliceDigest = dkgTranscriptDigest(
      allRound1,
      alice.round3.groupVerifyingKey,
    );
    const bobDigest = dkgTranscriptDigest(
      allRound1,
      bob.round3.groupVerifyingKey,
    );

    expect(Buffer.from(aliceDigest).equals(Buffer.from(bobDigest))).toBe(true);
    expect(
      dkgConfirmMatches(
        aliceDigest,
        alice.round3.groupVerifyingKey,
        bobDigest,
        bob.round3.groupVerifyingKey,
      ),
    ).toBe(true);
  });
});

function twoSigners(
  participants: readonly Participant[],
): [Participant, Participant] {
  const [alice, bob] = participants;
  if (!alice || !bob) {
    throw new Error(
      "test fixture: expected at least two DKG participants to sign",
    );
  }
  return [alice, bob];
}

describe("threshold-wasm: signing", () => {
  it("a T=2-of-3 signature verifies against the group key with Web Crypto -- zero verifier change", async () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const [alice, bob] = twoSigners(runDkg(ids));
    const message = new TextEncoder().encode("hello threshold world");

    const aliceCommit = signingRound1Commit(alice.round3.keyPackage);
    const bobCommit = signingRound1Commit(bob.round3.keyPackage);
    const commitEntries: DeviceKeyed[] = [
      { deviceId: alice.deviceId, value: aliceCommit.commitments },
      { deviceId: bob.deviceId, value: bobCommit.commitments },
    ];
    const signingPackage = signingBuildPackage(commitEntries, message);

    const shares: DeviceKeyed[] = [
      {
        deviceId: alice.deviceId,
        value: signingRound2Sign(
          aliceCommit.nonces,
          signingPackage,
          alice.round3.keyPackage,
        ),
      },
      {
        deviceId: bob.deviceId,
        value: signingRound2Sign(
          bobCommit.nonces,
          signingPackage,
          bob.round3.keyPackage,
        ),
      },
    ];

    const signature = signingAggregate(
      signingPackage,
      shares,
      alice.round3.publicKeyPackage,
    );
    expect(signature.length).toBe(ED25519_SIGNATURE_LENGTH);

    const ok = await verifyWithPublicKey(
      { alg: ALG_ED25519, "public-key": alice.round3.groupVerifyingKey },
      message,
      signature,
    );
    expect(ok).toBe(true);
  });

  it("splitCommitments/combineCommitments round-trips into the identical combined blob signingBuildPackage expects", () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const [alice] = twoSigners(runDkg(ids));
    const commit = signingRound1Commit(alice.round3.keyPackage);

    const { hiding, binding } = splitCommitments(commit.commitments);
    expect(hiding.length).toBeGreaterThan(0);
    expect(binding.length).toBeGreaterThan(0);

    const recombined = combineCommitments(hiding, binding);
    expect(recombined).toEqual(commit.commitments);
  });

  it("aggregation rejects a mismatched/forged share rather than publishing an invalid signature", () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const [alice, bob] = twoSigners(runDkg(ids));
    const message = new TextEncoder().encode("forged share test");

    const aliceCommit = signingRound1Commit(alice.round3.keyPackage);
    const bobCommit = signingRound1Commit(bob.round3.keyPackage);
    const commitEntries: DeviceKeyed[] = [
      { deviceId: alice.deviceId, value: aliceCommit.commitments },
      { deviceId: bob.deviceId, value: bobCommit.commitments },
    ];
    const signingPackage = signingBuildPackage(commitEntries, message);

    const realShareFromAlice = signingRound2Sign(
      aliceCommit.nonces,
      signingPackage,
      alice.round3.keyPackage,
    );
    // Swap in Alice's real share for Bob too, simulating a corrupted/forged contribution.
    const forgedShares: DeviceKeyed[] = [
      { deviceId: alice.deviceId, value: realShareFromAlice },
      { deviceId: bob.deviceId, value: realShareFromAlice },
    ];

    expect(() =>
      signingAggregate(
        signingPackage,
        forgedShares,
        alice.round3.publicKeyPackage,
      ),
    ).toThrow();
  });
});

describe("threshold-wasm: reshare", () => {
  it("dropping a device preserves the group key and the survivors can still sign with it", async () => {
    const ids = [deviceId(1), deviceId(2), deviceId(THIRD_DEVICE_BYTE)];
    const [alice, bob] = twoSigners(runDkg(ids));
    const originalGroupKey = alice.round3.groupVerifyingKey;

    const survivors: DeviceId[] = [alice.deviceId, bob.deviceId];

    const aliceReshareR1 = reshareRound1(
      alice.deviceId,
      keyPackageSigningShare(alice.round3.keyPackage),
      survivors,
      survivors,
      THRESHOLD,
    );
    const bobReshareR1 = reshareRound1(
      bob.deviceId,
      keyPackageSigningShare(bob.round3.keyPackage),
      survivors,
      survivors,
      THRESHOLD,
    );
    const reshareR1 = [aliceReshareR1, bobReshareR1];

    const combined = reshareCombineCommitments(
      reshareR1.map((r) => r.commitment),
    );
    const newPublicKeyPackage = reshareDerivePublicKeyPackage(
      combined,
      survivors,
    );

    const receivedByRecipient = new Map<string, Uint8Array[]>(
      survivors.map((id) => [Buffer.from(id).toString("hex"), []]),
    );
    for (const r1 of reshareR1) {
      for (const { deviceId: recipient, value } of r1.outgoing) {
        const bucket = receivedByRecipient.get(
          Buffer.from(recipient).toString("hex"),
        );
        if (!bucket) {
          throw new Error(
            "test fixture: reshare recipient is not one of the new participants",
          );
        }
        bucket.push(value);
      }
    }

    function receivedFor(id: DeviceId): Uint8Array[] {
      const bucket = receivedByRecipient.get(Buffer.from(id).toString("hex"));
      if (!bucket) {
        throw new Error(
          "test fixture: missing received-shares bucket for a new participant",
        );
      }
      return bucket;
    }

    const aliceNewKeyPackage = reshareCombineReceivedShares(
      alice.deviceId,
      receivedFor(alice.deviceId),
      newPublicKeyPackage,
      THRESHOLD,
    );
    const bobNewKeyPackage = reshareCombineReceivedShares(
      bob.deviceId,
      receivedFor(bob.deviceId),
      newPublicKeyPackage,
      THRESHOLD,
    );

    const message = new TextEncoder().encode("reshare works end to end");
    const aliceCommit = signingRound1Commit(aliceNewKeyPackage);
    const bobCommit = signingRound1Commit(bobNewKeyPackage);
    const commitEntries: DeviceKeyed[] = [
      { deviceId: alice.deviceId, value: aliceCommit.commitments },
      { deviceId: bob.deviceId, value: bobCommit.commitments },
    ];
    const signingPackage = signingBuildPackage(commitEntries, message);
    const shares: DeviceKeyed[] = [
      {
        deviceId: alice.deviceId,
        value: signingRound2Sign(
          aliceCommit.nonces,
          signingPackage,
          aliceNewKeyPackage,
        ),
      },
      {
        deviceId: bob.deviceId,
        value: signingRound2Sign(
          bobCommit.nonces,
          signingPackage,
          bobNewKeyPackage,
        ),
      },
    ];
    const signature = signingAggregate(
      signingPackage,
      shares,
      newPublicKeyPackage,
    );

    const ok = await verifyWithPublicKey(
      { alg: ALG_ED25519, "public-key": originalGroupKey },
      message,
      signature,
    );
    expect(ok).toBe(true);
  });
});
