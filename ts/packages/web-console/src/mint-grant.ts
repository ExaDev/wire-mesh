// Minting a grant from what a person typed: validating the fields, then handing them to core's mintCapabilityToken, which enforces the delegation rules (a delegated grant may only narrow its parent) and refuses rather than producing a token a verifier would reject.

import { capabilityVerbSchema } from "wire-mesh-core/generated/protocol";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import type { MintRefusalReason } from "wire-mesh-core/domain/tokens";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";

const TOKEN_ID_BYTE_LENGTH = 16;
const MS_PER_HOUR = 3_600_000;

/** The capabilities the core registry (spec/registry/core-capabilities.md) names, with the scope kind each is granted over, offered as suggestions in the form. Anyone may mint any well-formed verb; this only saves typing the common ones. */
export const KNOWN_CAPABILITIES: readonly {
  verb: string;
  scopeKind: string;
}[] = [
  { verb: "room:member", scopeKind: "room" },
  { verb: "room:join", scopeKind: "room" },
  { verb: "room:invite", scopeKind: "room" },
  { verb: "webrtc:signal", scopeKind: "node" },
  { verb: "relay:use", scopeKind: "node" },
  { verb: "pin:write", scopeKind: "folder" },
  { verb: "exec:pty", scopeKind: "folder" },
  { verb: "exec:proc", scopeKind: "folder" },
  { verb: "group:member", scopeKind: "group" },
];

export interface MintGrantInput {
  /** Hex device-id of the device the grant is for. */
  bearerHex: string;
  capability: string;
  scopeKind: string;
  /** Empty for a scope with no path. */
  scopePath: string;
  lifetimeHours: number;
  /** How many further delegation hops the grant permits, or undefined to leave it unset. */
  delegationsRemaining: number | undefined;
  /** A grant held by this device to delegate from, or undefined for a root grant. */
  parent: CapabilityToken | undefined;
}

export type MintGrantResult =
  { ok: true; token: CapabilityToken } | { ok: false; error: string };

const REFUSAL_TEXT: Readonly<Record<MintRefusalReason, string>> = {
  already_expired: "the grant would already have expired",
  parent_malformed: "the grant it delegates from is malformed",
  parent_bearer_mismatch:
    "the grant it delegates from is not held by this device",
  expires_exceeds_parent: "it would outlast the grant it delegates from",
  scope_does_not_narrow: "its scope is wider than the grant it delegates from",
  capability_mismatch:
    "its capability differs from the grant it delegates from",
  delegation_exceeds_parent: "it permits more delegation than its parent does",
};

function randomTokenId(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(TOKEN_ID_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function mintGrant(
  input: Readonly<MintGrantInput>,
  context: Readonly<{ identity: IdentityPort; clock: Clock }>,
): Promise<MintGrantResult> {
  let bearer;
  try {
    bearer = deviceIdFromHex(input.bearerHex.trim().toLowerCase());
  } catch {
    return {
      ok: false,
      error: "the bearer must be a 64-character hex device-id",
    };
  }
  const capability = capabilityVerbSchema.safeParse(input.capability.trim());
  if (!capability.success) {
    return {
      ok: false,
      error:
        "the capability must look like subsystem:action, for example room:member",
    };
  }
  if (input.scopeKind.trim() === "") {
    return { ok: false, error: "the scope needs a kind, for example room" };
  }
  if (!Number.isFinite(input.lifetimeHours) || input.lifetimeHours <= 0) {
    return { ok: false, error: "the lifetime must be more than zero hours" };
  }
  const scopePath = input.scopePath.trim();
  const verdict = await mintCapabilityToken({
    identity: context.identity,
    clock: context.clock,
    tokenId: randomTokenId(),
    bearer,
    capability: capability.data,
    scope: {
      kind: input.scopeKind.trim(),
      ...(scopePath === "" ? {} : { path: scopePath }),
    },
    expires: context.clock.now() + input.lifetimeHours * MS_PER_HOUR,
    ...(input.delegationsRemaining === undefined
      ? {}
      : { delegationsRemaining: input.delegationsRemaining }),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
  });
  return verdict.ok
    ? { ok: true, token: verdict.token }
    : { ok: false, error: `refused: ${REFUSAL_TEXT[verdict.reason]}` };
}
