/* The cases of mint.v1.json that pin the order of the checks and the conditions of every rule, kept apart from mint-vectors.ts, which holds the cases that mint and the queries.

   Two things are generated from lists rather than written one by one, so that a rule or an order a case does not pin cannot go unnoticed:

   - CONDITIONS names, for each condition that can produce a refusal reason (each disjunct of each rule), the case that breaks that condition and nothing else. The generator throws when a named case does not exist.
   - Each ordered chain of rules gives one case per neighbouring pair, which breaks both rules and expects the earlier one's reason. A pair whose two rules cannot both be broken in one token is listed in UNPAIRABLE with the reason, and the generator throws when a pair is neither generated nor listed. */

import type { CaseOptions, TokenSeed } from "./mint-vectors.ts";

/** What the order cases need from the generator that holds the rest of the file. */
export interface OrderContext {
  readonly mintCase: (seed: TokenSeed, options?: CaseOptions) => void;
  readonly fixture: (seed: TokenSeed) => string;
  readonly wireOf: (name: string) => string;
  readonly nowMs: number;
  readonly hourMs: number;
  readonly malformedTokenWire: string;
  readonly conditionsFor: (bearer: string) => string;
}

interface Rule {
  /** The refusal reason the rule gives. */
  reason: string;
  /** A name for the case, unique among the rules of a chain. */
  slug: string;
  /** The case holds only for an implementation with a Rust-sized integer. */
  rustOnly?: boolean;
  /** The seed with this rule broken, or undefined when it cannot be applied to the seed. */
  breakIt: (seed: TokenSeed) => TokenSeed | undefined;
}

const EXEC = "exec:pty";
const MANAGE_GRANT = "manage:grant";
const BEYOND_EXACT = 9_007_199_254_740_992;
const HALF = 2;

/** Condition name to the case that pins it. A condition is one disjunct of one rule: the failures a single rule can have. */
export const CONDITIONS: Readonly<Record<string, string>> = {
  "value_not_representable: expires": "refused_value_expires",
  "value_not_representable: not-before": "refused_value_not_before",
  "value_not_representable: delegations-remaining": "refused_value_delegations",
  "invalid_capability: the capability": "refused_invalid_capability",
  "invalid_capability: grants-capability": "refused_invalid_grants_capability",
  "invalid_capability: requests-capability":
    "refused_invalid_requests_capability",
  "already_expired: expires is now": "refused_already_expired",
  "already_expired: expires is before now":
    "refused_already_expired_before_now",
  links_exclusive: "refused_links_exclusive",
  "authorisation_parent_forbidden: a manage:grant token through a parent":
    "refused_grant_capability_through_a_parent",
  "authorisation_parent_forbidden: an authoriser with a parent":
    "refused_authoriser_with_a_parent",
  "parent_malformed: claims that do not decode": "refused_parent_malformed",
  "parent_malformed: a verb outside the grammar":
    "refused_parent_with_an_invalid_verb",
  parent_bearer_mismatch: "refused_parent_bearer_mismatch",
  expires_exceeds_parent: "refused_expires_exceeds_parent",
  "scope_does_not_narrow: another path": "refused_scope_does_not_narrow",
  "scope_does_not_narrow: another kind": "refused_scope_of_another_kind",
  "scope_does_not_narrow: a shared prefix is not a shared segment":
    "refused_scope_sibling_with_a_shared_prefix",
  "scope_does_not_narrow: no path under a parent with one":
    "refused_scope_without_a_path",
  "scope_does_not_narrow: a parent ending in a slash needs its slash":
    "refused_scope_parent_name_without_its_slash",
  "scope_does_not_narrow: a dot segment":
    "refused_scope_dot_segment_under_the_root_slash",
  capability_mismatch: "refused_capability_mismatch",
  "delegation_exceeds_parent: equal to the parent's":
    "refused_delegation_equal_to_parent",
  "delegation_exceeds_parent: unbounded under a bounded parent":
    "refused_delegation_unbounded_under_a_bounded_parent",
  "authorisation_malformed: claims that do not decode":
    "refused_authorisation_malformed",
  "authorisation_malformed: a verb outside the grammar":
    "refused_authoriser_with_an_invalid_verb",
  "authorisation_malformed: conditions bytes that do not decode":
    "refused_authorisation_conditions_undecodable",
  "authorisation_malformed: a condition node of an unsupported kind":
    "refused_authorisation_conditions_unsupported_node",
  authorisation_bearer_mismatch: "refused_authorisation_bearer_mismatch",
  "authorisation_capability_mismatch: the authoriser is not manage:grant":
    "refused_authoriser_is_not_manage_grant",
  "authorisation_capability_mismatch: grants-capability names another verb":
    "refused_authorisation_capability_mismatch",
  authorisation_scope_does_not_narrow: "refused_authorisation_scope",
  authorisation_exceeds_authoriser: "refused_authorisation_exceeds_authoriser",
  "authorisation_delegation_exceeds: unbounded under a bounded authoriser":
    "refused_authorisation_delegation_unbounded",
  "authorisation_delegation_exceeds: equal to the authoriser's":
    "refused_authorisation_delegation_equal",
  authorisation_conditions_not_satisfied:
    "refused_authorisation_conditions_self_grant",
};

/** Pairs of neighbouring rules whose two rules cannot both be broken in one token, with why. */
export const UNPAIRABLE: Readonly<Record<string, string>> = {
  "parent_malformed|bearer":
    "a parent that does not decode has no bearer to mismatch",
  "malformed|authoriser_parent":
    "an authoriser that does not decode has no parent link",
  "authorisation_conditions_undecodable|authorisation_conditions_not_satisfied":
    "conditions that do not decode cannot be evaluated",
};

/** The pairs written by hand in addOrderCases, because their authorisers are fixtures of their own. */
const MANUAL_PAIRS: ReadonlySet<string> = new Set([
  "authorisation_conditions_undecodable|authorisation_conditions_not_satisfied",
]);

/** The seed without one of its optional fields. */
function omit(
  seed: TokenSeed,
  field: "delegationsRemaining" | "grantsCapability",
): TokenSeed {
  const { delegationsRemaining, grantsCapability, ...rest } = seed;

  return {
    ...rest,
    ...(field !== "delegationsRemaining" && delegationsRemaining !== undefined
      ? { delegationsRemaining }
      : {}),
    ...(field !== "grantsCapability" && grantsCapability !== undefined
      ? { grantsCapability }
      : {}),
  };
}

/** The seed with no bound on how far it may be delegated further. */
function withoutHops(seed: TokenSeed): TokenSeed {
  return omit(seed, "delegationsRemaining");
}

interface Chain {
  /** A name for the chain, part of each case's name. */
  chain: string;
  rules: readonly Rule[];
  base: (name: string) => TokenSeed;
}

function chainPairs(
  { chain, rules, base }: Chain,
  ctx: OrderContext,
  unpairable: Set<string>,
): void {
  for (let index = 0; index + 1 < rules.length; index += 1) {
    const earlier = rules[index];
    const later = rules[index + 1];
    if (earlier === undefined || later === undefined) {
      continue;
    }
    const key = `${earlier.slug}|${later.slug}`;
    const name = `refused_order_${chain}_${earlier.slug}_before_${later.slug}`;
    const first = earlier.breakIt(base(name));
    const both = first === undefined ? undefined : later.breakIt(first);
    if (both === undefined) {
      if (!(key in UNPAIRABLE)) {
        throw new Error(
          `pair ${key} is neither generated nor listed as unpairable`,
        );
      }
      unpairable.add(key);
      continue;
    }
    ctx.mintCase(both, {
      refusal: earlier.reason,
      rustOnly: (earlier.rustOnly ?? false) || (later.rustOnly ?? false),
    });
  }
}

/** Registers every ordering case and every condition case that mint-vectors.ts does not hold, and checks the conditions list against the cases. */
export function addOrderCases(
  ctx: OrderContext,
  names: ReadonlySet<string>,
): void {
  const { nowMs, hourMs } = ctx;
  const parentWire = ctx.wireOf("root_grant");
  const grantWire = ctx.wireOf("grant_capability_root_with_bar");
  const future = (offset: number): number => nowMs + offset;

  const delegation = (name: string, bounded = true): TokenSeed => ({
    name,
    issuer: "b",
    bearer: "c",
    capability: EXEC,
    scope: { kind: "folder", path: "/work/sub" },
    expires: future(hourMs / HALF),
    ...(bounded ? { delegationsRemaining: 1 } : {}),
    parentWireHex: parentWire,
  });
  const authorised = (name: string, held: string = grantWire): TokenSeed => ({
    name,
    issuer: "b",
    bearer: "c",
    capability: EXEC,
    scope: { kind: "folder", path: "/work/x" },
    expires: future(hourMs / HALF),
    delegationsRemaining: 0,
    authorisedByWireHex: held,
  });
  const root = (name: string): TokenSeed => ({
    name,
    issuer: "a",
    bearer: "b",
    capability: EXEC,
    scope: { kind: "folder", path: "/work" },
    expires: future(hourMs),
  });
  const refuse = (
    seed: TokenSeed,
    reason: string,
    options: Readonly<CaseOptions> = {},
  ): void => {
    ctx.mintCase(seed, { ...options, refusal: reason });
  };

  // Fixtures: tokens held by someone, signed as written, which a mint would never produce.
  const grant = (name: string, over: Partial<TokenSeed>): TokenSeed => ({
    name,
    issuer: "a",
    bearer: "b",
    capability: MANAGE_GRANT,
    scope: { kind: "folder", path: "/work" },
    expires: future(hourMs),
    grantsCapability: EXEC,
    delegationsRemaining: 1,
    ...over,
  });
  const grantWithAParent = ctx.fixture(
    grant("grant_with_a_parent", { parentWireHex: parentWire }),
  );
  const execAuthoriser = ctx.fixture({
    ...root("authoriser_exec_parentless"),
    delegationsRemaining: 1,
  });
  const invalidVerbToken = ctx.fixture({
    ...root("token_with_an_invalid_verb"),
    capability: "exec",
  });
  const grantWithUndecodableConditions = ctx.fixture(
    grant("grant_with_undecodable_conditions", { conditionsHex: "ff" }),
  );
  const unsupportedNode = Buffer.from(
    "81a1646b696e6466657869737473",
    "hex",
  ).toString("hex");
  const grantWithAnUnsupportedNode = ctx.fixture(
    grant("grant_with_an_unsupported_node", { conditionsHex: unsupportedNode }),
  );
  const grantForAnyVerb = ctx.fixture(
    omit(grant("grant_for_any_verb", {}), "grantsCapability"),
  );
  const grantWithoutABound = ctx.fixture(
    omit(grant("grant_without_a_bound", {}), "delegationsRemaining"),
  );

  // Every condition has its own case: one rule, one disjunct, nothing else broken.
  refuse(
    { ...root("refused_value_expires"), expires: BEYOND_EXACT },
    "value_not_representable",
    { rustOnly: true },
  );
  refuse(
    { ...root("refused_value_not_before"), notBefore: BEYOND_EXACT },
    "value_not_representable",
    { rustOnly: true },
  );
  refuse(
    {
      ...root("refused_value_delegations"),
      delegationsRemaining: BEYOND_EXACT,
    },
    "value_not_representable",
    { rustOnly: true },
  );
  ctx.mintCase({
    ...root("minted_integers_at_the_boundary"),
    expires: BEYOND_EXACT - 1,
    delegationsRemaining: BEYOND_EXACT - 1,
  });
  refuse(
    {
      ...root("refused_invalid_requests_capability"),
      capability: "manage:request",
      requestsCapability: "two:colons:here",
    },
    "invalid_capability",
  );
  refuse(
    { ...root("refused_already_expired_before_now"), expires: nowMs - 1 },
    "already_expired",
  );
  refuse(
    {
      ...delegation("refused_parent_with_an_invalid_verb"),
      parentWireHex: invalidVerbToken,
    },
    "parent_malformed",
  );
  refuse(
    {
      ...delegation("refused_scope_sibling_with_a_shared_prefix"),
      scope: { kind: "folder", path: "/workshop" },
    },
    "scope_does_not_narrow",
  );
  refuse(
    {
      ...delegation("refused_scope_without_a_path"),
      scope: { kind: "folder" },
    },
    "scope_does_not_narrow",
  );
  refuse(
    authorised("refused_authoriser_with_a_parent", grantWithAParent),
    "authorisation_parent_forbidden",
  );
  refuse(
    authorised("refused_authoriser_with_an_invalid_verb", invalidVerbToken),
    "authorisation_malformed",
  );
  refuse(
    authorised(
      "refused_authorisation_conditions_undecodable",
      grantWithUndecodableConditions,
    ),
    "authorisation_malformed",
  );
  refuse(
    authorised(
      "refused_authorisation_conditions_unsupported_node",
      grantWithAnUnsupportedNode,
    ),
    "authorisation_malformed",
  );
  refuse(
    authorised("refused_authoriser_is_not_manage_grant", execAuthoriser),
    "authorisation_capability_mismatch",
  );
  refuse(
    {
      ...authorised("refused_authorisation_delegation_equal"),
      delegationsRemaining: 1,
    },
    "authorisation_delegation_exceeds",
  );
  // Rules whose absent optional lets everything through.
  ctx.mintCase({
    ...authorised("minted_through_a_grant_for_any_verb", grantForAnyVerb),
    capability: "fs:read",
  });
  ctx.mintCase(
    withoutHops(
      authorised(
        "minted_unbounded_under_an_unbounded_grant",
        grantWithoutABound,
      ),
    ),
  );

  // The chains of neighbouring rules.
  const unpairable = new Set<string>();
  const prefix: Rule[] = [
    {
      reason: "value_not_representable",
      slug: "value",
      rustOnly: true,
      breakIt: (s) => ({ ...s, expires: BEYOND_EXACT }),
    },
    {
      reason: "invalid_capability",
      slug: "verb",
      breakIt: (s) => ({ ...s, capability: "exec" }),
    },
    {
      reason: "already_expired",
      slug: "expiry",
      breakIt: (s) => ({ ...s, expires: nowMs }),
    },
    {
      reason: "links_exclusive",
      slug: "links",
      breakIt: (s) => ({ ...s, authorisedByWireHex: grantWire }),
    },
    {
      reason: "authorisation_parent_forbidden",
      slug: "grant_with_parent",
      breakIt: (s) => ({ ...s, capability: MANAGE_GRANT }),
    },
    {
      reason: "parent_malformed",
      slug: "parent_malformed",
      breakIt: (s) => ({ ...s, parentWireHex: ctx.malformedTokenWire }),
    },
  ];
  const parent: Rule[] = [
    {
      reason: "parent_malformed",
      slug: "parent_malformed",
      breakIt: (s) => ({ ...s, parentWireHex: ctx.malformedTokenWire }),
    },
    {
      reason: "parent_bearer_mismatch",
      slug: "bearer",
      breakIt: (s) =>
        s.parentWireHex === ctx.malformedTokenWire
          ? undefined
          : { ...s, issuer: "c", bearer: "a" },
    },
    {
      reason: "expires_exceeds_parent",
      slug: "expires",
      breakIt: (s) => ({ ...s, expires: future(2 * hourMs) }),
    },
    {
      reason: "scope_does_not_narrow",
      slug: "scope",
      breakIt: (s) => ({ ...s, scope: { kind: "folder", path: "/other" } }),
    },
    {
      reason: "capability_mismatch",
      slug: "verb",
      breakIt: (s) => ({ ...s, capability: "fs:read" }),
    },
    {
      reason: "delegation_exceeds_parent",
      slug: "hops",
      breakIt: (s) => ({ ...s, delegationsRemaining: 2 }),
    },
  ];
  const authorisation: Rule[] = [
    {
      reason: "authorisation_malformed",
      slug: "malformed",
      breakIt: (s) => ({ ...s, authorisedByWireHex: ctx.malformedTokenWire }),
    },
    {
      reason: "authorisation_parent_forbidden",
      slug: "authoriser_parent",
      breakIt: (s) =>
        s.authorisedByWireHex === ctx.malformedTokenWire
          ? undefined
          : { ...s, authorisedByWireHex: grantWithAParent },
    },
    {
      reason: "authorisation_bearer_mismatch",
      slug: "bearer",
      breakIt: (s) => ({ ...s, issuer: "c", bearer: "a" }),
    },
    {
      reason: "authorisation_capability_mismatch",
      slug: "verb",
      breakIt: (s) => ({ ...s, capability: "fs:read" }),
    },
    {
      reason: "authorisation_scope_does_not_narrow",
      slug: "scope",
      breakIt: (s) => ({ ...s, scope: { kind: "folder", path: "/other" } }),
    },
    {
      reason: "authorisation_exceeds_authoriser",
      slug: "expires",
      breakIt: (s) => ({ ...s, expires: future(2 * hourMs) }),
    },
    {
      reason: "authorisation_delegation_exceeds",
      slug: "hops",
      breakIt: withoutHops,
    },
  ];
  chainPairs(
    { chain: "checks", rules: prefix, base: delegation },
    ctx,
    unpairable,
  );
  chainPairs(
    { chain: "parent", rules: parent, base: delegation },
    ctx,
    unpairable,
  );
  chainPairs(
    {
      chain: "authorisation",
      rules: authorisation,
      base: (name) => authorised(name),
    },
    ctx,
    unpairable,
  );
  // The last authorisation pairs need an authoriser of their own: one with conditions that do not decode, and the self-grant bar.
  ctx.mintCase(
    {
      ...withoutHops(
        authorised(
          "refused_order_authorisation_hops_before_conditions_undecodable",
          grantWithUndecodableConditions,
        ),
      ),
    },
    { refusal: "authorisation_delegation_exceeds" },
  );
  ctx.mintCase(
    {
      ...withoutHops(
        authorised(
          "refused_order_authorisation_hops_before_conditions_unsatisfied",
          grantWire,
        ),
      ),
      bearer: "b",
    },
    { refusal: "authorisation_delegation_exceeds" },
  );
  const stale = Object.keys(UNPAIRABLE).filter(
    (pair) => !unpairable.has(pair) && !MANUAL_PAIRS.has(pair),
  );
  if (stale.length > 0) {
    throw new Error(
      `pairs listed as unpairable that were generated or do not exist: ${stale.join("; ")}`,
    );
  }

  const missing = Object.entries(CONDITIONS).filter(
    ([, name]) => !names.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `conditions without a case: ${missing.map(([condition]) => condition).join("; ")}`,
    );
  }
}
