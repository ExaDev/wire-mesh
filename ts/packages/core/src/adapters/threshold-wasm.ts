/**
 * A typed TS wrapper over the WASM build of `wire-mesh-threshold` (the audited `frost-core`/`frost-ed25519` crates, ZcashFoundation, NCC-audited) -- wire-mesh#29's own chosen route for a TS FROST(Ed25519, SHA-512) participant, over a from-scratch reimplementation of the cryptography.
 *
 * Built by `scripts/build-threshold-wasm.sh` into `wasm-dist/` (gitignored, a genuine compiled build artifact like `dist/`, never committed) -- run it before importing this module, in dev and in CI alike. This module performs NO domain logic of its own, only re-typing the raw wasm bindings' `Uint8Array`/`Array<any>` surface against this package's own `DeviceId` type and Node-capable-device-only availability: FROST participation cannot use Web Crypto at all (raw scalar/point arithmetic is deliberately outside what Web Crypto exposes), so unlike `node-identity.ts`'s counterpart in `web-crypto-identity.ts`, this adapter has no browser-side equivalent in v1 -- per wire-mesh#29's own resolved design, a browser is a threshold-group BEARER only, never a SHAREHOLDER, in v1.
 */
import { deviceIdSchema, type DeviceId } from "../generated/protocol.js";
import * as wasm from "../../wasm-dist/wire_mesh_threshold_wasm.js";

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** Copies into a fresh, whole-buffer `Uint8Array<ArrayBuffer>` -- the wasm-bindgen-generated `.d.ts` declares its `Uint8Array` returns unparameterized (`Uint8Array<ArrayBufferLike>`), which callers such as `verifyWithPublicKey` (`node-identity.ts`) reject; this is the same normalisation that adapter's own `toBufferSource` already applies at its boundary. */
function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

/** One `(deviceId, bytes)` pair -- the wasm boundary's own encoding of a map keyed by participant, since wasm-bindgen has no built-in `Map<Uint8Array, Uint8Array>` marshalling. */
export interface DeviceKeyed<T extends Uint8Array = Uint8Array<ArrayBuffer>> {
  deviceId: DeviceId;
  value: T;
}

function toParallelArrays(
  entries: readonly DeviceKeyed[],
): [unknown[], unknown[]] {
  return [entries.map((e) => e.deviceId), entries.map((e) => e.value)];
}

function fromParallelArrays(
  ids: readonly unknown[],
  values: readonly unknown[],
): DeviceKeyed[] {
  if (ids.length !== values.length) {
    throw new Error(
      `wasm returned mismatched parallel arrays: ${String(ids.length)} ids, ${String(values.length)} values`,
    );
  }
  const result: DeviceKeyed[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const value = values[i];
    if (!isUint8Array(value)) {
      throw new Error(
        "wasm returned a non-Uint8Array value in a parallel array",
      );
    }
    result.push({
      deviceId: deviceIdSchema.parse(id),
      value: toBufferSource(value),
    });
  }
  return result;
}

// --- DKG -----------------------------------------------------------------

export interface DkgRound1Result {
  secretPackage: Uint8Array<ArrayBuffer>;
  package: Uint8Array<ArrayBuffer>;
}

/** Round 1: samples this participant's own polynomial and commits to it. See `wire_mesh_threshold::dkg::round1`'s own doc comment for the full design. */
export function dkgRound1(
  ownDeviceId: DeviceId,
  maxSigners: number,
  minSigners: number,
): DkgRound1Result {
  const out = wasm.dkg_round1(ownDeviceId, maxSigners, minSigners);
  return {
    secretPackage: toBufferSource(out.secretPackage),
    package: toBufferSource(out.package),
  };
}

export interface SplitRound1PackageResult {
  commitment: Uint8Array<ArrayBuffer>[];
  proofOfKnowledge: Uint8Array<ArrayBuffer>;
}

/** Splits a serialized DKG round-1 package (dkgRound1's own `package` output) into `threshold-keygen-round1`'s own wire shape: the Feldman commitment as an array of independently-serialized coefficients (`commitment: [* bstr]`) and the Schnorr proof of knowledge as a separate byte string -- unlike frost-core's own combined-blob serialization. The inverse of combineRound1Package. */
export function splitRound1Package(
  serializedPackage: Uint8Array,
): SplitRound1PackageResult {
  const out = wasm.split_round1_package(serializedPackage);
  const commitment: Uint8Array<ArrayBuffer>[] = [];
  for (const coefficient of out.commitment) {
    if (!isUint8Array(coefficient)) {
      throw new Error(
        "wasm returned a non-Uint8Array entry in split_round1_package's own commitment array",
      );
    }
    commitment.push(toBufferSource(coefficient));
  }
  return {
    commitment,
    proofOfKnowledge: toBufferSource(out.proofOfKnowledge),
  };
}

/** Reconstructs a serialized DKG round-1 package (the same combined-blob shape dkgRound2/dkgRound3/dkgTranscriptDigest expect) from the two independently-serialized wire fields `threshold-keygen-round1` carries. The inverse of splitRound1Package. */
export function combineRound1Package(
  commitment: readonly Uint8Array[],
  proofOfKnowledge: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return toBufferSource(
    wasm.combine_round1_package([...commitment], proofOfKnowledge),
  );
}

export interface DkgRound2Result {
  secretPackage: Uint8Array<ArrayBuffer>;
  outgoing: DeviceKeyed[];
}

/** Round 2: verifies every other participant's round-1 proof of knowledge and computes this participant's own pairwise sub-shares. `round1` MUST NOT include this participant's own package. */
export function dkgRound2(
  ownSecretPackage: Uint8Array,
  round1: readonly DeviceKeyed[],
): DkgRound2Result {
  const [ids, packages] = toParallelArrays(round1);
  const out = wasm.dkg_round2(ownSecretPackage, ids, packages);
  return {
    secretPackage: toBufferSource(out.secretPackage),
    outgoing: fromParallelArrays(out.recipientIds, out.packages),
  };
}

export interface DkgRound3Result {
  keyPackage: Uint8Array<ArrayBuffer>;
  publicKeyPackage: Uint8Array<ArrayBuffer>;
  groupVerifyingKey: Uint8Array<ArrayBuffer>;
}

/** Round 3 (local, no wire traffic): verifies every received round-2 package and sums them into this participant's own long-term key package. `round1`/`round2` MUST NOT include this participant's own packages. */
export function dkgRound3(
  ownSecretPackage: Uint8Array,
  round1: readonly DeviceKeyed[],
  round2: readonly DeviceKeyed[],
): DkgRound3Result {
  const [ids1, packages1] = toParallelArrays(round1);
  const [ids2, packages2] = toParallelArrays(round2);
  const out = wasm.dkg_round3(
    ownSecretPackage,
    ids1,
    packages1,
    ids2,
    packages2,
  );
  return {
    keyPackage: toBufferSource(out.keyPackage),
    publicKeyPackage: toBufferSource(out.publicKeyPackage),
    groupVerifyingKey: toBufferSource(out.groupVerifyingKey),
  };
}

/** The echo-broadcast transcript digest this participant sends on `threshold-keygen-confirm` -- SHA-256 over the FULL ordered set of every round-1 package (including this participant's own), so two honest participants' digests are directly comparable. */
export function dkgTranscriptDigest(
  allRound1: readonly DeviceKeyed[],
  groupVerifyingKey: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const [ids, packages] = toParallelArrays(allRound1);
  return toBufferSource(
    wasm.dkg_transcript_digest(ids, packages, groupVerifyingKey),
  );
}

/** Verifies this participant's own transcript digest/group key against what a peer reported. A mismatch means the ceremony MUST abort, never be repaired in place. */
export function dkgConfirmMatches(
  ownDigest: Uint8Array,
  ownGroupKey: Uint8Array,
  peerDigest: Uint8Array,
  peerGroupKey: Uint8Array,
): boolean {
  return wasm.dkg_confirm_matches(
    ownDigest,
    ownGroupKey,
    peerDigest,
    peerGroupKey,
  );
}

/** Extracts a key package's own signing-share bytes -- what `reshareRound1` needs as `ownOldSigningShare`. */
export function keyPackageSigningShare(
  keyPackage: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return toBufferSource(wasm.key_package_signing_share(keyPackage));
}

// --- Signing ---------------------------------------------------------------

export interface SigningRound1Result {
  nonces: Uint8Array<ArrayBuffer>;
  commitments: Uint8Array<ArrayBuffer>;
}

/**
 * The pure-crypto half of round 1: generates a fresh nonce pair and its commitments. Persisting `nonces` durably before this participant's own round-1 response leaves the device is the CALLER's own obligation -- nonce reuse across two released signature shares discloses this participant's long-term key share outright. This function has no storage dependency and cannot enforce that obligation itself.
 */
export function signingRound1Commit(
  ownKeyPackage: Uint8Array,
): SigningRound1Result {
  const out = wasm.signing_round1_commit(ownKeyPackage);
  return {
    nonces: toBufferSource(out.nonces),
    commitments: toBufferSource(out.commitments),
  };
}

export interface SplitCommitmentsResult {
  hiding: Uint8Array<ArrayBuffer>;
  binding: Uint8Array<ArrayBuffer>;
}

/** Splits a serialized SigningCommitments blob (signingRound1Commit's own `commitments` output) into the two independently-serialized halves `threshold-commitment`'s wire shape carries (`hiding: bstr, binding: bstr`) -- unlike frost-core's own combined-blob serialization, which is opaque and not spec-shaped. The inverse of combineCommitments. */
export function splitCommitments(
  commitments: Uint8Array,
): SplitCommitmentsResult {
  const out = wasm.split_commitments(commitments);
  return {
    hiding: toBufferSource(out.hiding),
    binding: toBufferSource(out.binding),
  };
}

/** Reconstructs a serialized SigningCommitments blob (the same combined-blob shape signingBuildPackage/signingRound2Sign expect) from the two independently-serialized halves `threshold-commitment` carries on the wire. The inverse of splitCommitments. */
export function combineCommitments(
  hiding: Uint8Array,
  binding: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return toBufferSource(wasm.combine_commitments(hiding, binding));
}

/** Coordinator-side: builds the signing-package bytes every participant's round 2 is computed against. */
export function signingBuildPackage(
  commitments: readonly DeviceKeyed[],
  message: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const [ids, values] = toParallelArrays(commitments);
  return toBufferSource(wasm.signing_build_package(ids, values, message));
}

/** Round 2: releases this participant's signature share. The CALLER MUST have already taken (one-shot) `nonces` from its own durable nonce store before calling this. */
export function signingRound2Sign(
  nonces: Uint8Array,
  signingPackage: Uint8Array,
  ownKeyPackage: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return toBufferSource(
    wasm.signing_round2_sign(nonces, signingPackage, ownKeyPackage),
  );
}

/**
 * Coordinator-side: sums and verifies the collected shares into the final aggregate signature -- an ordinary 64-byte Ed25519 signature. Throws if verification fails (a malformed or forged share); a caller MUST treat any thrown error here as "publish nothing".
 */
export function signingAggregate(
  signingPackage: Uint8Array,
  shares: readonly DeviceKeyed[],
  publicKeyPackage: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const [ids, values] = toParallelArrays(shares);
  return toBufferSource(
    wasm.signing_aggregate(signingPackage, ids, values, publicKeyPackage),
  );
}

// --- Reshare -----------------------------------------------------------

export interface ReshareRound1Result {
  commitment: Uint8Array<ArrayBuffer>;
  outgoing: DeviceKeyed[];
}

/**
 * Survivor side: re-shares this device's own Lagrange-weighted sub-share of the group secret across a new (possibly different) participant set. See `wire_mesh_threshold::reshare`'s own module doc comment (Rust side) for the full design rationale -- deliberately not built on a zero-secret "refresh" delta, which cannot onboard a device with no prior share or safely change the threshold.
 */
export function reshareRound1(
  ownDeviceId: DeviceId,
  ownOldSigningShare: Uint8Array,
  survivorDeviceIds: readonly DeviceId[],
  newParticipantDeviceIds: readonly DeviceId[],
  newMinSigners: number,
): ReshareRound1Result {
  const out = wasm.reshare_round1(
    ownDeviceId,
    ownOldSigningShare,
    [...survivorDeviceIds],
    [...newParticipantDeviceIds],
    newMinSigners,
  );
  return {
    commitment: toBufferSource(out.commitment),
    outgoing: fromParallelArrays(out.recipientIds, out.shares),
  };
}

/** Splits a survivor's serialized broadcast commitment (reshareRound1's own `commitment` output) into `threshold-keygen-round1`'s own wire shape: an array of independently-serialized coefficients (`commitment: [* bstr]`) -- unlike reshareRound1's own whole-blob serialization. The inverse of reshareCombineCommitmentParts. */
export function reshareSplitCommitment(
  commitment: Uint8Array,
): Uint8Array<ArrayBuffer>[] {
  const out: Uint8Array<ArrayBuffer>[] = [];
  for (const part of wasm.reshare_split_commitment(commitment)) {
    if (!isUint8Array(part)) {
      throw new Error(
        "wasm returned a non-Uint8Array entry in reshare_split_commitment's own output array",
      );
    }
    out.push(toBufferSource(part));
  }
  return out;
}

/** Reconstructs a survivor's serialized broadcast commitment (the same whole-blob shape reshareCombineCommitments expects each entry of its own commitments array to be) from the wire's own per-coefficient array. The inverse of reshareSplitCommitment. */
export function reshareCombineCommitmentParts(
  parts: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  return toBufferSource(wasm.reshare_combine_commitment_parts([...parts]));
}

/** Sums T survivors' broadcast commitment vectors into the one combined VSS commitment `reshareDerivePublicKeyPackage` needs. */
export function reshareCombineCommitments(
  commitments: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  return toBufferSource(wasm.reshare_combine_commitments([...commitments]));
}

/** The group's derived public key given the combined commitment and the new participant set -- reused directly by `threshold-keygen-confirm`'s own group-key check (MUST equal the group's `existing-group-key` for a reshare). */
export function reshareDerivePublicKeyPackage(
  combinedCommitment: Uint8Array,
  newParticipantDeviceIds: readonly DeviceId[],
): Uint8Array<ArrayBuffer> {
  return toBufferSource(
    wasm.reshare_derive_public_key_package(combinedCommitment, [
      ...newParticipantDeviceIds,
    ]),
  );
}

/** New-participant side (local): verifies each received share against its own embedded commitment, sums the validated shares, and builds this participant's final key package. */
export function reshareCombineReceivedShares(
  ownDeviceId: DeviceId,
  received: readonly Uint8Array[],
  publicKeyPackage: Uint8Array,
  newMinSigners: number,
): Uint8Array<ArrayBuffer> {
  return toBufferSource(
    wasm.reshare_combine_received_shares(
      ownDeviceId,
      [...received],
      publicKeyPackage,
      newMinSigners,
    ),
  );
}
