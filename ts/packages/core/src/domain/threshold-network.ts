/**
 * Pure, transport-free `exadev.io/threshold` wire logic (wire-mesh#171): building and parsing the six manage-commands `spec/threshold.cddl` defines (threshold.commit/.sign/.abort, threshold.keygen-round1/round2/confirm), mirroring `domain/webrtc-signaling.ts`'s own split between pure command construction and a transport-consuming adapter. Deliberately has no dependency on `MeshSession` or any coordinator/participant role logic, so both the coordinator-facing adapter (`adapters/threshold-network-coordinator.ts`) and the participant-facing responder (`adapters/threshold-participant.ts`) share exactly this one implementation of the wire-level protocol.
 */
import type {
  CapabilityScope,
  CapabilityVerb,
  DeviceId,
  ManageCommand,
  ManageCommandParams,
  ThresholdAbort,
  ThresholdCommit,
  ThresholdCommitment,
  ThresholdKeygenConfirm,
  ThresholdKeygenRound1,
  ThresholdKeygenRound2,
  ThresholdSign,
} from "../generated/protocol.js";
import type { ThresholdSubject } from "./threshold-subject.js";

/** Gates threshold.commit/.sign/.abort -- the two-round signing protocol and its abort path. */
export const THRESHOLD_SIGN_VERB: CapabilityVerb = "exadev.io/threshold:sign";
/** Gates threshold.keygen-round1/round2/confirm when `existing-group-key` is absent on round1 -- a fresh DKG among devices that already trust each other. */
export const THRESHOLD_KEYGEN_VERB: CapabilityVerb =
  "exadev.io/threshold:keygen";
/** Gates the same keygen-round1/round2/confirm triplet when `existing-group-key` is present -- resharing can redefine the participant set entirely and is strictly more dangerous than an initial keygen, so it is a separately grantable and separately revocable capability (spec/threshold.cddl's own resolved design). */
export const THRESHOLD_RESHARE_VERB: CapabilityVerb =
  "exadev.io/threshold:reshare";

/** No path: `group` names the specific group within the params themselves (threshold-commit/-sign) or is established by the ceremony's own participant set (keygen-round1/round2/confirm) -- there is no filesystem-subtree-style resource to scope by path. */
export const THRESHOLD_GROUP_SCOPE: CapabilityScope = { kind: "group" };

/** Which capability verb gates one keygen-round1/round2/confirm ceremony, per spec/threshold.cddl's own verifier obligation: `exadev.io/threshold:reshare` when the ceremony carries an `existing-group-key` (round1), `exadev.io/threshold:keygen` otherwise. A caller drives one ceremony's round2/confirm messages under the SAME verb its own round1 used -- pass the same `isReshare` value to every builder for that session-id. */
export function keygenCapabilityVerb(isReshare: boolean): CapabilityVerb {
  return isReshare ? THRESHOLD_RESHARE_VERB : THRESHOLD_KEYGEN_VERB;
}

function hasVerb(params: ManageCommandParams, verb: string): boolean {
  return typeof params === "object" && "verb" in params && params.verb === verb;
}

export function isThresholdCommit(
  params: ManageCommandParams,
): params is ThresholdCommit {
  return hasVerb(params, "threshold.commit");
}

export function isThresholdSign(
  params: ManageCommandParams,
): params is ThresholdSign {
  return hasVerb(params, "threshold.sign");
}

export function isThresholdAbort(
  params: ManageCommandParams,
): params is ThresholdAbort {
  return hasVerb(params, "threshold.abort");
}

export function isThresholdKeygenRound1(
  params: ManageCommandParams,
): params is ThresholdKeygenRound1 {
  return hasVerb(params, "threshold.keygen-round1");
}

export function isThresholdKeygenRound2(
  params: ManageCommandParams,
): params is ThresholdKeygenRound2 {
  return hasVerb(params, "threshold.keygen-round2");
}

export function isThresholdKeygenConfirm(
  params: ManageCommandParams,
): params is ThresholdKeygenConfirm {
  return hasVerb(params, "threshold.keygen-confirm");
}

/** Round 1 of signing: sent to every prospective participant. Returning a commitment IS the participant's act of authorisation -- see threshold-subject's own comment. `sessionId` is a caller-chosen, per-ceremony correlation id (spec/CONVENTIONS.md), widened to `bigint` domain-side; the wire `session-id` field is a plain `uint`. */
export function buildCommitCommand(
  sessionId: bigint,
  group: DeviceId,
  subject: Readonly<ThresholdSubject>,
  deadlineUnixMs: number,
): ManageCommand {
  return {
    verb: THRESHOLD_SIGN_VERB,
    params: {
      verb: "threshold.commit",
      "session-id": Number(sessionId),
      group,
      subject,
      deadline: deadlineUnixMs,
    },
  };
}

/** Round 2 of signing: sent to every participant that committed, carrying every collected commitment so each participant re-derives the same SigningPackage. Deliberately carries no subject -- see threshold-sign's own CDDL comment. */
export function buildSignCommand(
  sessionId: bigint,
  commitments: readonly ThresholdCommitment[],
): ManageCommand {
  return {
    verb: THRESHOLD_SIGN_VERB,
    params: {
      verb: "threshold.sign",
      "session-id": Number(sessionId),
      commitments: [...commitments],
    },
  };
}

/** Aborts a signing, keygen, or reshare ceremony -- reusable across all three families, since a participant tracks which one a session-id belongs to from whichever message first introduced it. */
export function buildAbortCommand(
  sessionId: bigint,
  reason?: string,
): ManageCommand {
  return {
    verb: THRESHOLD_SIGN_VERB,
    params: {
      verb: "threshold.abort",
      "session-id": Number(sessionId),
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

export interface KeygenRound1Options {
  /** REQUIRED for a fresh DKG (existingGroupKey absent) -- load-bearing, not ceremonial: without it a participant broadcasting last could adaptively bias the resulting group key (the rogue-key attack). MAY be omitted for a reshare. */
  proofOfKnowledge?: Uint8Array;
  /** Present: this is a reshare of the named group's existing Ed25519 public key. Absent: a fresh DKG. Determines this command's own capability verb via keygenCapabilityVerb. */
  existingGroupKey?: Uint8Array;
}

/** Round 1 of DKG or reshare: broadcasts this participant's own Feldman VSS commitment (and, for a fresh DKG, its Schnorr proof of knowledge) to every other participant. The capability verb is derived from `options.existingGroupKey`'s presence via keygenCapabilityVerb -- callers driving the rest of this same ceremony (round2, confirm) must pass the identical fresh-vs-reshare choice to those builders. */
export function buildKeygenRound1Command(
  sessionId: bigint,
  threshold: number,
  participants: readonly DeviceId[],
  commitment: readonly Uint8Array[],
  options: Readonly<KeygenRound1Options> = {},
): ManageCommand {
  const isReshare = options.existingGroupKey !== undefined;
  return {
    verb: keygenCapabilityVerb(isReshare),
    params: {
      verb: "threshold.keygen-round1",
      "session-id": Number(sessionId),
      threshold,
      participants: [...participants],
      commitment: [...commitment],
      ...(options.proofOfKnowledge !== undefined
        ? { "proof-of-knowledge": options.proofOfKnowledge }
        : {}),
      ...(options.existingGroupKey !== undefined
        ? { "existing-group-key": options.existingGroupKey }
        : {}),
    },
  };
}

/** Round 2 of DKG or reshare: pairwise, confidential -- one message per recipient, carrying that recipient's own sub-share. MUST travel only over an end-to-end-confidential connection (spec/threshold.cddl's own comment). `isReshare` MUST match the value this ceremony's own round1 used. */
export function buildKeygenRound2Command(
  sessionId: bigint,
  share: Uint8Array,
  isReshare: boolean,
): ManageCommand {
  return {
    verb: keygenCapabilityVerb(isReshare),
    params: {
      verb: "threshold.keygen-round2",
      "session-id": Number(sessionId),
      share,
    },
  };
}

/** The mandatory echo-broadcast confirmation round: every participant exchanges a digest over the full ordered round-1 package set plus the derived group key. `isReshare` MUST match the value this ceremony's own round1 used. */
export function buildKeygenConfirmCommand(
  sessionId: bigint,
  transcriptDigest: Uint8Array,
  groupKey: Uint8Array,
  isReshare: boolean,
): ManageCommand {
  return {
    verb: keygenCapabilityVerb(isReshare),
    params: {
      verb: "threshold.keygen-confirm",
      "session-id": Number(sessionId),
      "transcript-digest": transcriptDigest,
      "group-key": groupKey,
    },
  };
}
