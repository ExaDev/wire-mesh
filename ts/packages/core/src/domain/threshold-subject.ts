/**
 * `threshold-subject` -- what a signing session actually asks a group to sign, and the single most important design decision in the whole protocol: it carries the FULL decoded content, never a bare hash. A participant that commits to an opaque digest is a blind signer, and the entire security value of T-of-N is that each participant independently reviews and authorises the content -- returning a round-1 commitment IS that act of authorisation. This module builds exactly the bytes a participant signs its round-1 commitment over: the RFC 9052 §4.4 `Sig_structure`, reusing `tokens.ts`'s own `sig1ToBeSigned` rather than a second hand-rolled construction, and NEVER accepting a pre-assembled to-be-signed blob from a coordinator. Mirrors `wire_mesh_threshold::subject` on the Rust side exactly.
 */
import { sig1ToBeSigned } from "./tokens.js";

/**
 * The `kind` discriminator on `threshold-subject` -- an open `tstr` per `spec/CONVENTIONS.md`'s own open-tstr-over-closed-enum convention, since future content a group signs is not limited to what wire-mesh itself already defines self-certifying payloads for.
 */
export interface ThresholdSubject {
  kind: string;
  /** `bstr .cbor cose-token-headers` -- the protected header the aggregate signature will carry. */
  protected: Uint8Array;
  /** `bstr .cbor` of the claims structure `kind` names. */
  payload: Uint8Array;
}

/**
 * The kinds this participant recognises out of the box -- `capability-token`, `revocation-entry`, `handle-record`, and `room-notice` are the self-certifying payload shapes this codebase already defines. A caller extending recognised kinds (e.g. an application-defined one) supplies its own recogniser rather than this module growing a closed list.
 */
export const KNOWN_KINDS: readonly string[] = [
  "capability-token",
  "revocation-entry",
  "handle-record",
  "room-notice",
];

/**
 * A participant's decision on whether to authorise a `threshold-subject`. Deliberately not a bare `boolean`: a refusal MUST carry a reason so the coordinator (and, ideally, a human reviewing a denied session) can understand why, matching this spec's own fail-closed-with-a-reason idiom elsewhere (`manage-error.message`, `threshold-abort.reason`).
 */
export type SubjectDecision =
  { authorise: true } | { authorise: false; reason: string };

/**
 * The verifier obligation `spec/threshold.cddl` states directly: an unrecognised `kind` MUST be refused, never signed blindly. This is the fail-closed default every content policy is checked against BEFORE any kind-specific review runs; a caller's own policy closure only ever gets a chance to run for a kind it (or `KNOWN_KINDS`) actually recognises.
 */
export function refuseUnrecognisedKind(
  subject: ThresholdSubject,
  known: readonly string[] = KNOWN_KINDS,
): SubjectDecision | undefined {
  if (known.includes(subject.kind)) {
    return undefined;
  }
  return {
    authorise: false,
    reason: `unrecognised threshold-subject.kind ${JSON.stringify(subject.kind)} -- refusing to sign`,
  };
}

/**
 * Reconstructs the exact bytes this participant signs its round-1 commitment (and, transitively, its round-2 share) over -- the Sig_structure built from THIS participant's own decoding of `protected`/`payload`, never a coordinator-supplied to-be-signed blob.
 */
export function toBeSigned(subject: ThresholdSubject): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(sig1ToBeSigned(subject.protected, subject.payload));
}
