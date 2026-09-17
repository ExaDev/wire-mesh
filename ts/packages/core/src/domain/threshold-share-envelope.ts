/**
 * `threshold-share-claims`/`threshold-share-envelope` -- a round-2 signature share, wrapped in its own additional `cose-sign1` signed under the releasing participant's own PERSONAL device key, never the group's. This is what makes misbehaviour publicly provable rather than merely locally identifiable to the coordinator: anyone holding this envelope, not just the coordinator that requested the share, can attribute a specific released share to a specific, identifiable device. Mirrors `wire_mesh_threshold::share_envelope` on the Rust side exactly, reusing this package's own `sig1ToBeSigned`/self-certification pattern (`domain/tokens.ts`'s `mintCapabilityToken`/`verifyCapabilityToken`) rather than a second hand-rolled construction.
 */
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  thresholdShareClaimsSchema,
  type DeviceId,
  type ThresholdShareClaims,
  type ThresholdShareEnvelope,
} from "../generated/protocol.js";
import type { IdentityPort } from "../ports/identity.js";
import { bytesEqual } from "./token-scope.js";
import { sig1ToBeSigned } from "./tokens.js";

/** Normalises cbor2's encode() to a fresh, non-shared, whole-buffer Uint8Array<ArrayBuffer> -- what the generated schemas' concrete-typed fields require, matching tokens.ts's own private encodeBuf. */
function encodeBuf(value: unknown): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(encode(value, cdeEncodeOptions));
}

/** The domain-level view of `threshold-share-claims`, with `session-id` widened to `bigint` (matching `ThresholdCoordinator`'s own convention -- see `adapters/threshold-identity.ts`) rather than the wire schema's plain `number`. */
export interface ThresholdShareClaimsDomain {
  sessionId: bigint;
  group: DeviceId;
  /** The raw FROST `round2::SignatureShare` bytes -- opaque at this layer. */
  share: Uint8Array<ArrayBuffer>;
  /** The releasing participant's own PERSONAL device-id, never the group's. */
  issuer: DeviceId;
}

/**
 * Mints a `threshold-share-envelope`: signs `claims` under `personalIdentity`'s own key (never the group's) via the same RFC 9052 Sig_structure every other self-certifying structure in this codebase uses.
 */
export async function mintShareEnvelope(
  personalIdentity: Readonly<IdentityPort>,
  sessionId: bigint,
  group: DeviceId,
  share: Uint8Array,
): Promise<ThresholdShareEnvelope> {
  const claims: ThresholdShareClaims = {
    "session-id": Number(sessionId),
    group,
    share: Uint8Array.from(share),
    issuer: personalIdentity.deviceId,
    "issuer-key": personalIdentity.identityKey,
  };
  const payload = encodeBuf(claims);
  const protectedHeader = encodeBuf({
    1: personalIdentity.identityKey.alg,
    4: personalIdentity.deviceId,
  });
  const signature = await personalIdentity.sign(
    sig1ToBeSigned(protectedHeader, payload),
  );
  return [protectedHeader, {}, payload, signature];
}

/**
 * Verifies a `threshold-share-envelope` and returns its claims: checks self-certification (`sha256(issuer-key.public-key) == issuer`), then the signature against the embedded `issuer-key` -- the same two-step obligation every other self-certifying structure in this spec carries. Returns undefined for anything malformed or unverifiable, never throws -- hostile input produces a verdict, matching `verifyCapabilityToken`'s own convention. A caller that additionally requires the envelope to have come from one SPECIFIC expected participant checks the returned claims' `issuer` itself; this function's own job is only the envelope's internal consistency.
 */
export async function verifyShareEnvelope(
  identity: Readonly<IdentityPort>,
  envelope: Readonly<ThresholdShareEnvelope>,
): Promise<ThresholdShareClaimsDomain | undefined> {
  const [protectedHeader, , payload, signature] = envelope;
  if (payload === null) {
    return undefined;
  }

  let decoded: unknown;
  try {
    decoded = decode(payload, cdeDecodeOptions);
  } catch {
    return undefined;
  }
  const result = thresholdShareClaimsSchema.safeParse(decoded);
  if (!result.success) {
    return undefined;
  }
  const claims = result.data;

  const derivedIssuer = await identity.deriveDeviceId(
    claims["issuer-key"]["public-key"],
  );
  if (!bytesEqual(derivedIssuer, claims.issuer)) {
    return undefined;
  }

  const toBeSigned = sig1ToBeSigned(protectedHeader, payload);
  const ok = await identity.verify(claims["issuer-key"], toBeSigned, signature);
  if (!ok) {
    return undefined;
  }

  return {
    sessionId: BigInt(claims["session-id"]),
    group: claims.group,
    share: Uint8Array.from(claims.share),
    issuer: claims.issuer,
  };
}
