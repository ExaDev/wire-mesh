/* mint.v1.json: what minting a capability token or a revocation entry produces, and refuses.

   Every token below is built here from the spec text with node:crypto alone, never by an implementation: the claims are written out field by field, encoded with cbor2's CDE mode and signed with Ed25519, whose signatures are deterministic, so a conformant minter given the same inputs produces the same bytes. The refusal each rejected case expects is written by hand from tokens.cddl, so the vectors check an implementation against the spec and not against itself. */

import { createHash, sign as nodeSign } from "node:crypto";
import { cdeEncodeOptions, encode } from "cbor2";
import { hex, type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";
import {
  identityNamed,
  wireHex,
  type Identity,
} from "./secure-channel-crypto.ts";

export const MINT_LAYOUT_VERSION = 1;
const NOW_MS = 1_893_456_000_000;
const HOUR_MS = 3_600_000;
const TOKEN_ID_BYTES = 16;
const HALF = 2;
const QUARTER = 4;
const TWICE = 2;
const ONE_SECOND_MS = 1_000;
const HALF_HOUR_MS = HOUR_MS / HALF;
const QUARTER_HOUR_MS = HOUR_MS / QUARTER;
const TWO_HOURS_MS = TWICE * HOUR_MS;
const TWO_HOPS = 2;
const ONE_HOP = 1;
const NO_HOPS = 0;
const ALG_LABEL = "1";
const KID_LABEL = "4";
const MANAGE_GRANT = "manage:grant";
const EXEC = "exec:pty";

interface Scope {
  kind: string;
  path?: string;
}

interface TokenSeed {
  /** The case's own name, from which its token-id is derived. */
  name: string;
  issuer: string;
  bearer: string;
  capability: string;
  scope: Scope;
  expires: number;
  notBefore?: number;
  delegationsRemaining?: number;
  conditionsHex?: string;
  parentWireHex?: string;
  authorisedByWireHex?: string;
  grantsCapability?: string;
  requestsCapability?: string;
  nowMs?: number;
}

/** A token-id derived from the case's name, so no two cases share one and none is a number to keep in step. */
function tokenIdHex(name: string): string {
  return createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, TOKEN_ID_BYTES * HALF);
}

/** The RFC 9052 Sig_structure of a COSE_Sign1 with no external data, encoded canonically. Plain Uint8Arrays carry the byte strings: a Node Buffer would be encoded through its JSON form. */
function signingInputWireHex(protectedHex: string, payloadHex: string): string {
  return Buffer.from(
    encode(
      [
        "Signature1",
        Uint8Array.from(Buffer.from(protectedHex, "hex")),
        new Uint8Array(0),
        Uint8Array.from(Buffer.from(payloadHex, "hex")),
      ],
      cdeEncodeOptions,
    ),
  ).toString("hex");
}

/** The COSE_Sign1 of `claims` signed by `signer`, as the wire-form JSON the other token vectors use and its wire bytes. */
function coseSign1(
  signer: Identity,
  claims: JsonWire,
): { message: JsonWire; wireHex: string } {
  const protectedHex = wireHex({
    [ALG_LABEL]: signer.alg,
    [KID_LABEL]: hex(signer.deviceId.toString("hex")),
  });
  const payloadHex = wireHex(claims);
  const signature = nodeSign(
    null,
    Buffer.from(signingInputWireHex(protectedHex, payloadHex), "hex"),
    signer.privateKey,
  );
  const message: JsonWire = [
    hex(protectedHex),
    {},
    hex(payloadHex),
    hex(signature.toString("hex")),
  ];

  return { message, wireHex: wireHex(message) };
}

function scopeJson(scope: Scope): JsonWire {
  return scope.path === undefined
    ? { kind: scope.kind }
    : { kind: scope.kind, path: scope.path };
}

function claimsFor(seed: TokenSeed): JsonWire {
  const issuer = identityNamed(seed.issuer);
  const bearer = identityNamed(seed.bearer);

  return {
    "token-id": hex(tokenIdHex(seed.name)),
    issuer: hex(issuer.deviceId.toString("hex")),
    "issuer-key": {
      alg: issuer.alg,
      "public-key": hex(issuer.publicKey.toString("hex")),
    },
    bearer: hex(bearer.deviceId.toString("hex")),
    capability: seed.capability,
    scope: scopeJson(seed.scope),
    expires: seed.expires,
    ...(seed.notBefore === undefined ? {} : { "not-before": seed.notBefore }),
    ...(seed.parentWireHex === undefined
      ? {}
      : { parent: hex(seed.parentWireHex) }),
    ...(seed.delegationsRemaining === undefined
      ? {}
      : { "delegations-remaining": seed.delegationsRemaining }),
    ...(seed.conditionsHex === undefined
      ? {}
      : { conditions: hex(seed.conditionsHex) }),
    ...(seed.authorisedByWireHex === undefined
      ? {}
      : { "authorised-by": hex(seed.authorisedByWireHex) }),
    ...(seed.grantsCapability === undefined
      ? {}
      : { "grants-capability": seed.grantsCapability }),
    ...(seed.requestsCapability === undefined
      ? {}
      : { "requests-capability": seed.requestsCapability }),
  };
}

function conditionsFor(bearer: string): string {
  const bar = {
    kind: "not",
    operand: {
      kind: "and",
      left: {
        kind: "compare",
        op: "eq",
        left: {
          kind: "delegate",
          system: "granted-capability-is",
          payload: EXEC,
        },
        right: { kind: "booleanLiteral", value: true },
      },
      right: {
        kind: "compare",
        op: "eq",
        left: {
          kind: "delegate",
          system: "grantee-is",
          payload: identityNamed(bearer).deviceId.toString("hex"),
        },
        right: { kind: "booleanLiteral", value: true },
      },
    },
  };

  return Buffer.from(encode([bar], cdeEncodeOptions)).toString("hex");
}

/** A hand-written cose-sign1 whose claims are an empty map: it decodes as a token and has none of its fields. */
const MALFORMED_TOKEN_WIRE = wireHex([
  hex("a0"),
  {},
  hex("a0"),
  hex("00".repeat(TOKEN_ID_BYTES * HALF)),
]);

function rootSeed(
  name: string,
  overrides: Partial<TokenSeed> = {},
): TokenSeed {
  return {
    name,
    issuer: "a",
    bearer: "b",
    capability: EXEC,
    scope: { kind: "folder", path: "/work" },
    expires: NOW_MS + HOUR_MS,
    ...overrides,
  };
}

interface CaseOptions {
  /** The refusal reason; absent when the mint must produce the token. */
  refusal?: string;
  /** Whether the minted token verifies on its own at `NOW_MS`. */
  verifiesOnItsOwn?: boolean;
}

interface GrantQueryOptions {
  nowMs?: number;
  held?: string;
}

interface Candidate {
  capability: string;
  scope: Scope;
  expires: number;
  delegationsRemaining: number | null;
}

function candidateJson(candidate: Candidate): JsonWire {
  return {
    capability: candidate.capability,
    scope: scopeJson(candidate.scope),
    expires: candidate.expires,
    delegations_remaining: candidate.delegationsRemaining,
  };
}

/** Everything of mint.v1.json: the top-level round-trip vectors and the `mint` section. */
export function mintFile(): {
  vectors: Vector[];
  extra: Record<string, JsonWire>;
} {
  const vectors: Vector[] = [];
  const minted = new Map<string, string>();
  const tokenMints: JsonWire[] = [];

  /** Records one case, signing the expected token when the case must mint. */
  function mintCase(seed: TokenSeed, options: CaseOptions = {}): void {
    let expected: JsonWire;
    if (options.refusal === undefined) {
      const token = coseSign1(identityNamed(seed.issuer), claimsFor(seed));
      vectors.push({
        name: `mint_${seed.name}`,
        message: token.message,
        wire_hex: token.wireHex,
      });
      minted.set(seed.name, token.wireHex);
      expected = {
        result: "minted",
        vector: `mint_${seed.name}`,
        verifies: options.verifiesOnItsOwn ?? true,
      };
    } else {
      expected = { result: "refused", reason: options.refusal };
    }
    tokenMints.push({
      name: seed.name,
      issuer: seed.issuer,
      now_ms: seed.nowMs ?? NOW_MS,
      token_id_hex: tokenIdHex(seed.name),
      bearer: seed.bearer,
      capability: seed.capability,
      scope: scopeJson(seed.scope),
      expires: seed.expires,
      not_before: seed.notBefore ?? null,
      delegations_remaining: seed.delegationsRemaining ?? null,
      conditions_hex: seed.conditionsHex ?? null,
      parent_wire_hex: seed.parentWireHex ?? null,
      authorised_by_wire_hex: seed.authorisedByWireHex ?? null,
      grants_capability: seed.grantsCapability ?? null,
      requests_capability: seed.requestsCapability ?? null,
      expected,
    });
  }

  const wireOf = (name: string): string => {
    const found = minted.get(name);
    if (found === undefined) {
      throw new Error(`mint case ${name} has not produced a token`);
    }

    return found;
  };

  // Tokens that mint.
  mintCase(rootSeed("root_grant", { delegationsRemaining: TWO_HOPS }));
  mintCase(
    rootSeed("root_grant_with_not_before", {
      notBefore: NOW_MS - HOUR_MS,
      scope: { kind: "folder" },
    }),
  );
  mintCase({
    name: "delegation_one_hop",
    issuer: "b",
    bearer: "c",
    capability: EXEC,
    scope: { kind: "folder", path: "/work/sub" },
    expires: NOW_MS + HALF_HOUR_MS,
    delegationsRemaining: ONE_HOP,
    parentWireHex: wireOf("root_grant"),
  });
  mintCase({
    name: "delegation_second_hop",
    issuer: "c",
    bearer: "a",
    capability: EXEC,
    scope: { kind: "folder", path: "/work/sub/deeper" },
    expires: NOW_MS + QUARTER_HOUR_MS,
    delegationsRemaining: NO_HOPS,
    parentWireHex: wireOf("delegation_one_hop"),
  });
  mintCase(
    rootSeed("request_capability_root", {
      capability: "manage:request",
      requestsCapability: EXEC,
    }),
  );
  // A grant-capability's conditions bind the token it authorises, so on its own they are indeterminate and refuse it: it verifies only as the authoriser of a token minted through it.
  mintCase(
    rootSeed("grant_capability_root_with_bar", {
      capability: MANAGE_GRANT,
      grantsCapability: EXEC,
      delegationsRemaining: ONE_HOP,
      conditionsHex: conditionsFor("b"),
    }),
    { verifiesOnItsOwn: false },
  );
  const grantWire = wireOf("grant_capability_root_with_bar");
  const authorisedBase = (name: string, bounded = true): TokenSeed => ({
    name,
    issuer: "b",
    bearer: "c",
    capability: EXEC,
    scope: { kind: "folder", path: "/work/x" },
    expires: NOW_MS + HALF_HOUR_MS,
    ...(bounded ? { delegationsRemaining: NO_HOPS } : {}),
    authorisedByWireHex: grantWire,
  });
  mintCase(authorisedBase("authorised_by_grant"));

  // Refusals, one per reason, each with only that rule broken unless it says otherwise.
  const parent = wireOf("root_grant");
  const delegationBase = (name: string, bounded = true): TokenSeed => ({
    name,
    issuer: "b",
    bearer: "c",
    capability: EXEC,
    scope: { kind: "folder", path: "/work/sub" },
    expires: NOW_MS + HALF_HOUR_MS,
    ...(bounded ? { delegationsRemaining: ONE_HOP } : {}),
    parentWireHex: parent,
  });
  const refuse = (seed: TokenSeed, refusal: string): void => {
    mintCase(seed, { refusal });
  };
  refuse(rootSeed("refused_already_expired", { expires: NOW_MS }), "already_expired");
  refuse(rootSeed("refused_invalid_capability", { capability: "exec" }), "invalid_capability");
  refuse(
    rootSeed("refused_invalid_grants_capability", {
      capability: MANAGE_GRANT,
      grantsCapability: "two:colons:here",
    }),
    "invalid_capability",
  );
  refuse(
    { ...delegationBase("refused_links_exclusive"), authorisedByWireHex: grantWire },
    "links_exclusive",
  );
  refuse(
    { ...delegationBase("refused_grant_capability_through_a_parent"), capability: MANAGE_GRANT },
    "authorisation_parent_forbidden",
  );
  refuse(
    { ...delegationBase("refused_parent_malformed"), parentWireHex: MALFORMED_TOKEN_WIRE },
    "parent_malformed",
  );
  refuse(
    { ...delegationBase("refused_parent_bearer_mismatch"), issuer: "c", bearer: "a" },
    "parent_bearer_mismatch",
  );
  refuse(
    { ...delegationBase("refused_expires_exceeds_parent"), expires: NOW_MS + TWO_HOURS_MS },
    "expires_exceeds_parent",
  );
  refuse(
    { ...delegationBase("refused_scope_does_not_narrow"), scope: { kind: "folder", path: "/other" } },
    "scope_does_not_narrow",
  );
  refuse(
    { ...delegationBase("refused_scope_of_another_kind"), scope: { kind: "room", path: "/work/sub" } },
    "scope_does_not_narrow",
  );
  refuse(
    { ...delegationBase("refused_capability_mismatch"), capability: "fs:read" },
    "capability_mismatch",
  );
  refuse(
    { ...delegationBase("refused_delegation_equal_to_parent"), delegationsRemaining: TWO_HOPS },
    "delegation_exceeds_parent",
  );
  refuse(
    delegationBase("refused_delegation_unbounded_under_a_bounded_parent", false),
    "delegation_exceeds_parent",
  );
  // Breaks the bearer rule and the expiry rule: the bearer rule is checked first.
  refuse(
    {
      ...delegationBase("refused_bearer_before_expiry"),
      issuer: "c",
      bearer: "a",
      expires: NOW_MS + TWO_HOURS_MS,
    },
    "parent_bearer_mismatch",
  );
  refuse(
    { ...authorisedBase("refused_authorisation_malformed"), authorisedByWireHex: MALFORMED_TOKEN_WIRE },
    "authorisation_malformed",
  );
  refuse(
    { ...authorisedBase("refused_authorisation_by_a_token_with_a_parent"), authorisedByWireHex: wireOf("delegation_one_hop") },
    "authorisation_parent_forbidden",
  );
  refuse(
    { ...authorisedBase("refused_authorisation_bearer_mismatch"), issuer: "c", bearer: "a" },
    "authorisation_bearer_mismatch",
  );
  refuse(
    { ...authorisedBase("refused_authorisation_capability_mismatch"), capability: "fs:read" },
    "authorisation_capability_mismatch",
  );
  refuse(
    { ...authorisedBase("refused_authorisation_scope"), scope: { kind: "folder", path: "/other" } },
    "authorisation_scope_does_not_narrow",
  );
  refuse(
    { ...authorisedBase("refused_authorisation_exceeds_authoriser"), expires: NOW_MS + TWO_HOURS_MS },
    "authorisation_exceeds_authoriser",
  );
  refuse(
    authorisedBase("refused_authorisation_delegation_unbounded", false),
    "authorisation_delegation_exceeds",
  );
  refuse(
    { ...authorisedBase("refused_authorisation_conditions_self_grant"), bearer: "b" },
    "authorisation_conditions_not_satisfied",
  );

  // Revocation entries, each revoking the minted token of the case it is named for.
  const revocationMints: JsonWire[] = [];
  for (const [name, issuer, revoked, revokedAt] of [
    ["revoke_root_grant", "a", "root_grant", NOW_MS - ONE_SECOND_MS],
    ["revoke_delegation", "b", "delegation_one_hop", NOW_MS],
  ] as const) {
    const signer = identityNamed(issuer);
    const entry = coseSign1(signer, {
      "token-id": hex(tokenIdHex(revoked)),
      issuer: hex(signer.deviceId.toString("hex")),
      "issuer-key": {
        alg: signer.alg,
        "public-key": hex(signer.publicKey.toString("hex")),
      },
      "revoked-at": revokedAt,
    });
    vectors.push({ name: `mint_${name}`, message: entry.message, wire_hex: entry.wireHex });
    revocationMints.push({
      name,
      issuer,
      token_id_hex: tokenIdHex(revoked),
      revoked_at: revokedAt,
      vector: `mint_${name}`,
    });
  }

  // canGrant and canGrantVia, with the verdict written by hand.
  const delegation: Candidate = {
    capability: EXEC,
    scope: { kind: "folder", path: "/work/sub" },
    expires: NOW_MS + HALF_HOUR_MS,
    delegationsRemaining: ONE_HOP,
  };
  const canGrantCases: JsonWire[] = [];
  const grantQuery = (
    name: string,
    query: { device: string; candidate: Candidate; expected: boolean },
    options: GrantQueryOptions = {},
  ): void => {
    canGrantCases.push({
      name,
      held_wire_hex: options.held ?? parent,
      device: query.device,
      candidate: candidateJson(query.candidate),
      now_ms: options.nowMs ?? NOW_MS,
      expected: query.expected,
    });
  };
  const yes = (device: string, candidate: Candidate) => ({ device, candidate, expected: true });
  const no = (device: string, candidate: Candidate) => ({ device, candidate, expected: false });
  grantQuery("can_grant_a_narrower_delegation", yes("b", delegation));
  grantQuery("can_grant_not_for_another_device", no("c", delegation));
  grantQuery("can_grant_not_a_wider_scope", no("b", { ...delegation, scope: { kind: "folder", path: "/other" } }));
  grantQuery("can_grant_not_a_later_expiry", no("b", { ...delegation, expires: NOW_MS + TWO_HOURS_MS }));
  grantQuery("can_grant_not_another_verb", no("b", { ...delegation, capability: "fs:read" }));
  grantQuery("can_grant_not_the_same_hops", no("b", { ...delegation, delegationsRemaining: TWO_HOPS }));
  grantQuery("can_grant_not_an_expired_candidate", no("b", { ...delegation, expires: NOW_MS - 1 }));
  grantQuery("can_grant_not_from_a_malformed_token", no("b", delegation), {
    held: MALFORMED_TOKEN_WIRE,
  });

  const authorisation: Candidate = {
    ...delegation,
    scope: { kind: "folder", path: "/work/x" },
    delegationsRemaining: NO_HOPS,
  };
  const viaCases: JsonWire[] = [];
  const viaQuery = (
    name: string,
    query: { device: string; bearer: string; candidate: Candidate; expected: boolean },
    held: string = grantWire,
  ): void => {
    viaCases.push({
      name,
      held_wire_hex: held,
      device: query.device,
      candidate: candidateJson(query.candidate),
      candidate_bearer: query.bearer,
      now_ms: NOW_MS,
      expected: query.expected,
    });
  };
  const via = (device: string, bearer: string, candidate: Candidate, expected: boolean) => ({
    device,
    bearer,
    candidate,
    expected,
  });
  viaQuery("can_grant_via_to_another_bearer", via("b", "c", authorisation, true));
  viaQuery("can_grant_via_not_to_itself", via("b", "b", authorisation, false));
  viaQuery("can_grant_via_not_for_another_device", via("c", "a", authorisation, false));
  viaQuery("can_grant_via_not_another_verb", via("b", "c", { ...authorisation, capability: "fs:read" }, false));
  viaQuery(
    "can_grant_via_not_from_a_token_with_a_parent",
    via("b", "c", authorisation, false),
    wireOf("delegation_one_hop"),
  );

  const identityEntries: Record<string, JsonWire> = {};
  for (const name of ["a", "b", "c"]) {
    const identity = identityNamed(name);
    identityEntries[name] = {
      alg: identity.alg,
      synthetic: true,
      secret_hex: identity.secretHex,
      public_key_hex: identity.publicKey.toString("hex"),
      device_id_hex: identity.deviceId.toString("hex"),
    };
  }

  return {
    vectors,
    extra: {
      mint: {
        layout_version: MINT_LAYOUT_VERSION,
        now_ms: NOW_MS,
        identities: identityEntries,
        token_mints: tokenMints,
        revocation_mints: revocationMints,
        can_grant: canGrantCases,
        can_grant_via: viaCases,
      },
    },
  };
}
