/**
 * A group's `IdentityPort`, from wire-mesh#29's own design: "`IdentityPort` is already exactly the right shape... a `createThresholdIdentity` factory returns an object satisfying the UNMODIFIED interface." `sign` is opaque bytes in, opaque bytes out, no assumption about where the private half lives -- but a threshold `sign` needs real network round trips to other participants, which this module cannot itself perform (it has no transport dependency, matching this codebase's own port/adapter layering). [`ThresholdCoordinator`] is the contract a caller supplies for those round trips; a real implementation drives it over `manage-request`/`manage-response` exactly as `core/webrtc`'s own negotiation does (`mesh-session.ts`'s `sendManageRequest`), a test implementation can run every participant in-process (see this module's own test file).
 *
 * The one genuine wart, named rather than hidden (per the design's own "leave the port alone and reject with a typed error" recommendation): `IdentityPort.sign` implies local, fast, and effectively infallible. A threshold `sign` is slow, can fail on participant unavailability, and can be refused by a participant's own content policy -- so [`sign`] always rejects, and [`signSubject`] (which needs a [`ThresholdSubject`], not a bare message) is the real entry point.
 */
import type { DeviceId, IdentityKey } from "../generated/protocol.js";
import type { IdentityPort } from "../ports/identity.js";
import { deriveDeviceId, verifyWithPublicKey } from "./node-identity.js";
import {
  signingAggregate,
  signingBuildPackage,
  type DeviceKeyed,
} from "./threshold-wasm.js";
import type { ThresholdSubject } from "../domain/threshold-subject.js";
import { toBeSigned } from "../domain/threshold-subject.js";

/** One participant's round-1 response: its FROST commitments, keyed by device-id. */
export type SigningCommitmentEntry = DeviceKeyed;

/** One participant's round-2 response: its signature share, keyed by device-id. */
export type SignatureShareEntry = DeviceKeyed;

/**
 * The network side of threshold signing, supplied by the caller. Never assumes a specific transport, framing, or retry/timeout policy -- those are the caller's own concern, matching this project's async-contracts convention. A second implementation on a completely different transport (a different harness's own RPC, an in-process test double) satisfies this exact contract with zero changes to the contract or its callers.
 */
export interface ThresholdCoordinator {
  /**
   * Sends `threshold-commit` to every one of `participants` for `subject`, and collects at least `threshold` valid responses. Implementations decide their own quorum/timeout/retry policy; this call either returns enough commitments to proceed or rejects.
   */
  commitRound: (
    sessionId: bigint,
    participants: readonly DeviceId[],
    subject: ThresholdSubject,
    deadlineUnixMs: number,
  ) => Promise<SigningCommitmentEntry[]>;

  /**
   * Sends `threshold-sign` (the collected commitments, no subject) to every participant that committed, and collects their signature shares.
   */
  signRound: (
    sessionId: bigint,
    commitments: readonly SigningCommitmentEntry[],
  ) => Promise<SignatureShareEntry[]>;
}

export interface ThresholdIdentity extends IdentityPort {
  /**
   * The real entry point: signs `subject` (never a bare hash -- `ThresholdSubject` always carries the full decoded content, per this domain's own non-negotiable security invariant), round-tripping through the coordinator for both FROST rounds, then verifying the aggregate signature before returning it.
   */
  signSubject: (
    subject: ThresholdSubject,
    deadlineUnixMs: number,
  ) => Promise<Uint8Array<ArrayBuffer>>;
}

const ALG_ED25519 = -8;
const FIRST_SESSION_ID = 1n;
const SESSION_ID_STEP = 1n;

/**
 * Builds a group's threshold-backed `IdentityPort`. `deviceId`/ `identityKey` are the group's own (`group-device-id = SHA-256(group public key)`, the ordinary `identity.cddl` rule applied to the DKG's output) -- indistinguishable on the wire from any ordinary single-device Ed25519 identity, per this domain's own defining property.
 */
export async function createThresholdIdentity(
  groupVerifyingKey: Uint8Array,
  publicKeyPackage: Uint8Array,
  threshold: number,
  participants: readonly DeviceId[],
  coordinator: Readonly<ThresholdCoordinator>,
): Promise<ThresholdIdentity> {
  const deviceId = await deriveDeviceId(groupVerifyingKey);
  const identityKey: IdentityKey = {
    alg: ALG_ED25519,
    "public-key": Uint8Array.from(groupVerifyingKey),
  };
  let nextSessionId = FIRST_SESSION_ID;

  return {
    deviceId,
    identityKey,
    async sign() {
      return Promise.reject(
        new Error(
          "ThresholdIdentity.sign requires a ThresholdSubject, not a bare message -- use signSubject",
        ),
      );
    },
    verify: verifyWithPublicKey,
    deriveDeviceId,
    async signSubject(subject, deadlineUnixMs) {
      const sessionId = nextSessionId;
      nextSessionId += SESSION_ID_STEP;

      const commitments = await coordinator.commitRound(
        sessionId,
        participants,
        subject,
        deadlineUnixMs,
      );
      if (commitments.length < threshold) {
        throw new Error(
          `only ${String(commitments.length)} of ${String(threshold)} required participants committed`,
        );
      }

      const shares = await coordinator.signRound(sessionId, commitments);

      const message = toBeSigned(subject);
      const signingPackage = signingBuildPackage(commitments, message);
      const signature = signingAggregate(
        signingPackage,
        shares,
        publicKeyPackage,
      );

      const ok = await verifyWithPublicKey(identityKey, message, signature);
      if (!ok) {
        throw new Error(
          "aggregate threshold signature failed to verify against the group's own key -- refusing to return it",
        );
      }
      return signature;
    },
  };
}
