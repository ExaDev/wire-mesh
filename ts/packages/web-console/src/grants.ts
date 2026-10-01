// What the console does with a capability token beyond passing it along: reading its claims, turning it into a grant code a person can copy to another device, and judging whether it still holds. All of the cryptographic work is wire-mesh-core's; this only shapes it for a person.

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  capabilityTokenSchema,
  tokenClaimsSchema,
  type CapabilityToken,
  type TokenClaims,
} from "wire-mesh-core/generated/protocol";
import { verifyCapabilityToken } from "wire-mesh-core/domain/tokens";
import type {
  TokenVerdictReason,
  VerifyCapabilityTokenOptions,
} from "wire-mesh-core/domain/tokens";

/** Marks a grant code so a pasted string that is not one is refused with a clear message, and so a future encoding can be told apart. */
export const GRANT_CODE_PREFIX = "wm-grant1.";

/** The claims a token carries, or undefined when its payload is absent or is not a token-claims map. Reading claims does not verify anything; use `grantStatus` for that. */
export function decodeGrantClaims(
  token: CapabilityToken,
): TokenClaims | undefined {
  const payload = token[2];
  if (payload === null) return undefined;
  let decoded: unknown;
  try {
    decoded = decode(payload, cdeDecodeOptions);
  } catch {
    return undefined;
  }
  const parsed = tokenClaimsSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The token as a single copyable string: the prefix, then the CBOR-encoded token in URL-safe base64. */
export function encodeGrantCode(token: CapabilityToken): string {
  return GRANT_CODE_PREFIX + toBase64Url(encode(token, cdeEncodeOptions));
}

/**
 * The token a grant code carries.
 * @throws Error when the text is not a grant code, or its token is malformed.
 */
export function decodeGrantCode(code: string): CapabilityToken {
  const trimmed = code.trim();
  if (!trimmed.startsWith(GRANT_CODE_PREFIX)) {
    throw new Error(`a grant code starts with "${GRANT_CODE_PREFIX}"`);
  }
  let decoded: unknown;
  try {
    decoded = decode(
      fromBase64Url(trimmed.slice(GRANT_CODE_PREFIX.length)),
      cdeDecodeOptions,
    );
  } catch {
    throw new Error("the grant code is damaged: it does not decode");
  }
  const parsed = capabilityTokenSchema.safeParse(decoded);
  if (!parsed.success || decodeGrantClaims(parsed.data) === undefined) {
    throw new Error("the grant code does not carry a capability token");
  }
  return parsed.data;
}

/** Whether a grant still holds, and if not why, as core's verifier judged it. */
export type GrantStatus =
  { kind: "valid" } | { kind: "invalid"; reason: TokenVerdictReason };

export async function grantStatus(
  token: CapabilityToken,
  options: Readonly<VerifyCapabilityTokenOptions>,
): Promise<GrantStatus> {
  const verdict = await verifyCapabilityToken(token, options);
  return verdict.ok
    ? { kind: "valid" }
    : { kind: "invalid", reason: verdict.reason };
}

const REASON_TEXT: Readonly<Record<TokenVerdictReason, string>> = {
  malformed: "malformed",
  bad_signature: "signature does not verify",
  wrong_issuer: "issuer does not match its key",
  bearer_mismatch: "names another bearer",
  expired: "expired",
  not_yet_valid: "not valid yet",
  content_expired: "content expired",
  revoked: "revoked",
  delegation_exceeds_parent: "exceeds what its parent allows",
  parent_invalid: "its parent grant is no longer valid",
  conditions_invalid: "its conditions are invalid",
  conditions_not_satisfied: "its conditions are not met",
  authorisation_invalid: "exceeds what its authorising grant allows",
  chain_too_deep: "its chain is deeper than allowed",
  chain_cycle: "its chain revisits a token",
};

export function describeGrantStatus(status: Readonly<GrantStatus>): string {
  return status.kind === "valid" ? "valid" : REASON_TEXT[status.reason];
}
