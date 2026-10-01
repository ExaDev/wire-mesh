// Minting a grant from what a person typed: validating the fields, then handing them to core's mintCapabilityToken, which enforces the delegation rules (a delegated grant may only narrow its parent) and refuses rather than producing a token a verifier would reject.

import { capabilityVerbSchema } from "wire-mesh-core/generated/protocol";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { MANAGE_REQUEST_CAPABILITY } from "wire-mesh-core/domain/capability-request";
import {
  MANAGE_GRANT_CAPABILITY,
  mintCapabilityToken,
} from "wire-mesh-core/domain/tokens";
import type { MintRefusalReason } from "wire-mesh-core/domain/tokens";
import { noSelfGrantBar } from "wire-mesh-core/domain/token-predicates";
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
  { verb: MANAGE_GRANT_CAPABILITY, scopeKind: "folder" },
  { verb: MANAGE_REQUEST_CAPABILITY, scopeKind: "room" },
];

/** The two capabilities whose token names the single verb it covers, and so the claim that carries it. */
const TARGET_VERB_CLAIM: Readonly<
  Record<string, "grantsCapability" | "requestsCapability">
> = {
  [MANAGE_GRANT_CAPABILITY]: "grantsCapability",
  [MANAGE_REQUEST_CAPABILITY]: "requestsCapability",
};

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
  /** A manage:grant held by this device that authorises this mint, or absent for none. Mutually exclusive with `parent`. */
  authorisedBy?: CapabilityToken | undefined;
  /** For a manage:grant or manage:request: the one verb it covers, or empty (or absent) for any verb within its scope. */
  targetVerb?: string;
  /** For a manage:grant: verbs the holder is barred from granting to itself, each becoming one subject-mode condition on the token. */
  selfGrantBars?: readonly string[];
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
  links_exclusive:
    "it would carry both a parent grant and an authorising grant",
  authorisation_malformed: "the grant authorising it is malformed",
  authorisation_parent_forbidden:
    "a grant permission cannot be delegated from a parent grant",
  authorisation_bearer_mismatch:
    "the grant authorising it is not held by this device",
  authorisation_capability_mismatch:
    "the grant authorising it names a different capability",
  authorisation_scope_does_not_narrow:
    "its scope is wider than the grant authorising it",
  authorisation_exceeds_authoriser: "it would outlast the grant authorising it",
  authorisation_delegation_exceeds:
    "it permits more delegation than the grant authorising it does",
  authorisation_conditions_not_satisfied:
    "the grant authorising it does not allow this mint",
};

type TargetVerb =
  | {
      ok: true;
      claim?: "grantsCapability" | "requestsCapability";
      verb?: string;
    }
  | { ok: false; error: string };

/** Reads the optional covered verb against the capability being minted: only a manage:grant or manage:request names one, and a given verb must be well formed. */
function parseTargetVerb(
  capability: string,
  raw: string | undefined,
): TargetVerb {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { ok: true };
  const claim = TARGET_VERB_CLAIM[capability];
  if (claim === undefined) {
    return {
      ok: false,
      error: `only ${MANAGE_GRANT_CAPABILITY} and ${MANAGE_REQUEST_CAPABILITY} name a verb they cover`,
    };
  }
  const verb = capabilityVerbSchema.safeParse(trimmed);
  if (!verb.success) {
    return {
      ok: false,
      error:
        "the covered verb must look like subsystem:action, for example room:member",
    };
  }
  return { ok: true, claim, verb: verb.data };
}

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
  if (
    input.delegationsRemaining !== undefined &&
    !(
      Number.isSafeInteger(input.delegationsRemaining) &&
      input.delegationsRemaining >= 0
    )
  ) {
    return {
      ok: false,
      error: "further delegations must be a whole number, zero or more",
    };
  }
  const target = parseTargetVerb(capability.data, input.targetVerb);
  if (!target.ok) {
    return target;
  }
  const bars = input.selfGrantBars ?? [];
  if (bars.length > 0 && capability.data !== MANAGE_GRANT_CAPABILITY) {
    return {
      ok: false,
      error: `only a ${MANAGE_GRANT_CAPABILITY} can bar its holder from granting to itself`,
    };
  }
  const barNodes = [];
  for (const raw of bars) {
    const barred = capabilityVerbSchema.safeParse(raw.trim());
    if (!barred.success) {
      return {
        ok: false,
        error: `the barred verb "${raw}" must look like subsystem:action`,
      };
    }
    barNodes.push(noSelfGrantBar(barred.data, bearer));
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
    // The token schema requires a whole number of milliseconds, which a fractional number of hours would not give.
    expires: Math.round(
      context.clock.now() + input.lifetimeHours * MS_PER_HOUR,
    ),
    ...(input.delegationsRemaining === undefined
      ? {}
      : { delegationsRemaining: input.delegationsRemaining }),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    ...(input.authorisedBy === undefined
      ? {}
      : { authorisedBy: input.authorisedBy }),
    ...(target.claim === undefined || target.verb === undefined
      ? {}
      : { [target.claim]: target.verb }),
    ...(barNodes.length === 0 ? {} : { conditions: barNodes }),
  });
  return verdict.ok
    ? { ok: true, token: verdict.token }
    : { ok: false, error: `refused: ${REFUSAL_TEXT[verdict.reason]}` };
}
