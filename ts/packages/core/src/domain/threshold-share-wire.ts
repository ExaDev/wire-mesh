/**
 * `share: bstr .cbor threshold-share-envelope` -- threshold-sign's own manage-ok extension carries the envelope nested one level deeper than the generic `ManageOk`/`ManageError` codec decodes: the outer bstr comes back as a plain `Uint8Array` (ManageOk's own extension tail has no per-field schema, see manage-ok's `catchall(z.unknown())`), and the CBOR-encoded `threshold-share-envelope` inside it needs its own decode step -- the same "outer bstr, nested CBOR" pattern `token-claims.parent`/`revocation-announce-frame`'s own entries already use for a self-certifying structure embedded inside another.
 */
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  coseSign1Schema,
  type ThresholdShareEnvelope,
} from "../generated/protocol.js";

/** Decodes threshold-sign's own `share` field (the outer bstr a generic manage-ok decode already produced) into its nested threshold-share-envelope. Returns undefined for anything malformed, never throws -- hostile/corrupted input produces a verdict at the call site, matching this codebase's own fail-closed convention for self-certifying structures. */
export function decodeShareEnvelopeBytes(
  bytes: Uint8Array,
): ThresholdShareEnvelope | undefined {
  let decoded: unknown;
  try {
    decoded = decode(bytes, cdeDecodeOptions);
  } catch {
    return undefined;
  }
  const result = coseSign1Schema.safeParse(decoded);
  return result.success ? result.data : undefined;
}

/** Encodes a threshold-share-envelope as the bytes threshold-sign's own manage-ok `share` field carries -- the inverse of decodeShareEnvelopeBytes. */
export function encodeShareEnvelope(
  envelope: Readonly<ThresholdShareEnvelope>,
): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(encode(envelope, cdeEncodeOptions));
}
