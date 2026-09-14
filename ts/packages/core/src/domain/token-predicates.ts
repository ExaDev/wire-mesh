import {
  evaluatePredicate as trileanEvaluatePredicate,
  PredicateNodeSchema,
  type JsonValue,
  type PredicateNode,
  type Resolution,
  type Resolvers,
} from "trilean";
import { z } from "zod";
import type { DeviceId, TokenClaims } from "../generated/protocol.js";
import type { Clock } from "../ports/clock.js";
import { bytesEqual, scopeNarrows } from "./token-scope.js";

/** The wire shape of `token-claims.conditions` once CBOR-decoded: trilean's own PredicateNodeSchema is the single source of truth for what a condition entry may contain, re-validated here rather than trusted from a CDDL-generated shadow schema (see tokens.cddl's own comment on why `conditions` is an opaque bstr, not a native CDDL type) -- a token from an untrusted peer must pass trilean's real schema before any of its conditions are evaluated. Explicitly annotated: trilean's PredicateNodeSchema is a deeply recursive z.lazy() type whose inferred shape is too large for tsdown's declaration-file generator to serialise (TS7056) without this. */
export const conditionsListSchema: z.ZodType<PredicateNode[]> =
  z.array(PredicateNodeSchema);

/**
 * tokens.cddl's mandated core predicate-op vocabulary (issue #85): the five narrowing checks a verifier previously enforced as five hardcoded `if`s, now expressed as `delegate` systems every conforming verifier registers a handler for. Order matches the historical check order in verifyTokenChain/checkNarrowing, preserved so a caller mapping a failing system to its own reason vocabulary (MintRefusalReason's five distinct values; verifyTokenChain's single collapsed "delegation_exceeds_parent") sees the same check run first that always ran first.
 */
export const BEARER_IS = "bearer-is";
export const EXPIRES_AT = "expires-at";
export const SCOPE_NARROWS = "scope-narrows";
export const CAPABILITY_IS = "capability-is";
export const DEPTH_REMAINING = "depth-remaining";

export type NarrowingSystem =
  | typeof BEARER_IS
  | typeof EXPIRES_AT
  | typeof SCOPE_NARROWS
  | typeof CAPABILITY_IS
  | typeof DEPTH_REMAINING;

const NARROWING_SYSTEMS: readonly NarrowingSystem[] = [
  BEARER_IS,
  EXPIRES_AT,
  SCOPE_NARROWS,
  CAPABILITY_IS,
  DEPTH_REMAINING,
];

function isNarrowingSystem(system: string): system is NarrowingSystem {
  return (
    system === BEARER_IS ||
    system === EXPIRES_AT ||
    system === SCOPE_NARROWS ||
    system === CAPABILITY_IS ||
    system === DEPTH_REMAINING
  );
}

/** Everything needed to check candidate against parent, restated from tokens.ts's own NarrowingCandidate/checkNarrowing shape rather than requiring a full TokenClaims for the not-yet-minted child -- the same reasoning mintCapabilityToken's own checkNarrowing already applies (a delegation candidate has no token-id/issuer-key/bearer of its own yet). camelCase field names, matching NarrowingCandidate's own convention, deliberately distinct from TokenClaims' hyphenated wire field names. */
export interface NarrowingCandidate {
  capability: TokenClaims["capability"];
  scope: TokenClaims["scope"];
  expires: number;
  delegationsRemaining?: number;
}

/**
 * The local evaluation context every token predicate op reads from -- trilean's own `EvaluationContext` is deliberately typed `unknown` (an opaque, in-process value never serialised as part of the tree), so this is wire-mesh's own concrete shape for it. `childIssuer`/`candidate` describe the not-yet-minted or being-verified child; `parentClaims` is the already-decoded-and-verified parent, present only when narrowing is actually being checked against one. No clock: none of the five structural narrowing checks reason about the current time (unlike a conditions-list entry, which might -- see ConditionsContext).
 */
export interface TokenPredicateContext {
  readonly childIssuer: DeviceId;
  readonly candidate: Readonly<NarrowingCandidate>;
  readonly parentClaims?: Readonly<TokenClaims>;
}

/** A `conditions` entry's own generic evaluation context: no parent/candidate distinction, since a domain-specific condition (a message TTL, a future revoke-authorization check) reasons about the presented token's own claims directly, not a not-yet-minted delegation candidate. */
export interface ConditionsContext {
  readonly clock: Clock;
  readonly claims: Readonly<TokenClaims>;
}

/** One delegate system's own handler: given the delegate node's payload and the concrete context it was invoked with, resolves to a boolean-valued Resolution. Handlers never throw for a data-quality problem -- an op that cannot make sense of its own payload/context returns `{found: false}`, which the evaluator turns into a fail-closed `indeterminate`. */
export type TokenDelegateHandler<TContext> = (
  payload: JsonValue,
  context: TContext,
) => Resolution | Promise<Resolution>;

function booleanFound(value: boolean): Resolution {
  return { found: true, value: { kind: "boolean", value } };
}

/** The five mandatory narrowing ops, each reading only from TokenPredicateContext -- never the delegate node's own payload, since every fact each op needs (which parent, which candidate) already travels via the context the caller constructs per evaluation, not via wire-encoded payload data. A context with no parentClaims (narrowing is being checked with nothing to narrow against) resolves every op to `false` rather than throwing -- fail-closed, matching how an indeterminate result already refuses a token. */
const narrowingHandlers: Record<
  NarrowingSystem,
  TokenDelegateHandler<TokenPredicateContext>
> = {
  [BEARER_IS]: (_payload, context) => {
    if (context.parentClaims === undefined) return booleanFound(false);
    return booleanFound(
      bytesEqual(context.parentClaims.bearer, context.childIssuer),
    );
  },
  [EXPIRES_AT]: (_payload, context) => {
    if (context.parentClaims === undefined) return booleanFound(false);
    return booleanFound(
      context.candidate.expires <= context.parentClaims.expires,
    );
  },
  [SCOPE_NARROWS]: (_payload, context) => {
    if (context.parentClaims === undefined) return booleanFound(false);
    return booleanFound(
      scopeNarrows(context.parentClaims.scope, context.candidate.scope),
    );
  },
  [CAPABILITY_IS]: (_payload, context) => {
    if (context.parentClaims === undefined) return booleanFound(false);
    return booleanFound(
      context.parentClaims.capability === context.candidate.capability,
    );
  },
  // Narrowing applies to delegations-remaining too: a parent that bounds further re-delegation must not be re-delegatable into an unbounded (or merely equal) child -- that would let any bearer of a bounded grant mint an unboundedly-redelegatable one, defeating the entire point of the claim. A parent carrying none is itself unbounded, so any child value is admissible.
  [DEPTH_REMAINING]: (_payload, context) => {
    if (context.parentClaims === undefined) return booleanFound(false);
    const parentRemaining = context.parentClaims["delegations-remaining"];
    if (parentRemaining === undefined) return booleanFound(true);
    return booleanFound(
      context.candidate.delegationsRemaining !== undefined &&
        context.candidate.delegationsRemaining < parentRemaining,
    );
  },
};

/** `{kind:"compare", op:"eq", left:{kind:"delegate", system, payload:null}, right:{kind:"booleanLiteral", value:true}}` -- delegate is an ExpressionNode, not itself a PredicateNode (trilean's PredicateNodeSchema has no `delegate` member), so every predicate op is expressed this way: resolve the delegate to a boolean ComputedValue, then compare it against the literal `true`. */
function delegateIsTrue(system: string): PredicateNode {
  return {
    kind: "compare",
    op: "eq",
    left: { kind: "delegate", system, payload: null },
    right: { kind: "booleanLiteral", value: true },
  };
}

/** trilean's three required resolvers are never exercised by any node this module constructs (narrowing/conditions nodes are built entirely from `compare`+`delegate`+`booleanLiteral`, never `reference`/`lookup`/`fold`/`some`/`every`) -- these stubs exist only because `Resolvers` requires them structurally. */
const unusedResolveValue: Resolvers["resolveValue"] = async () =>
  Promise.resolve({ found: false });
const unusedResolveLookup: Resolvers["resolveLookup"] = async () =>
  Promise.resolve({ found: false });
const unusedResolveCollection: Resolvers["resolveCollection"] = async () =>
  Promise.resolve([]);

/**
 * Evaluates the five mandatory narrowing predicates against parentClaims/candidate, in their historical check order, short-circuiting on and returning the first that does not hold. Returns undefined when every check holds. This is the single mechanism both mintCapabilityToken's own pre-mint check and verifyTokenChain's own delegation-chain walk call -- the two can never silently drift into different ideas of what "narrows" means, because there is now exactly one implementation of each check, not two hardcoded copies.
 */
export async function evaluateNarrowing(
  parentClaims: Readonly<TokenClaims>,
  childIssuer: DeviceId,
  candidate: Readonly<NarrowingCandidate>,
): Promise<NarrowingSystem | undefined> {
  const context: TokenPredicateContext = {
    childIssuer,
    candidate,
    parentClaims,
  };
  const resolvers: Readonly<Resolvers> = {
    resolveValue: unusedResolveValue,
    resolveLookup: unusedResolveLookup,
    resolveCollection: unusedResolveCollection,
    resolveDelegate: async (system, payload) => {
      if (!isNarrowingSystem(system)) return { found: false };
      return narrowingHandlers[system](payload, context);
    },
  };
  for (const system of NARROWING_SYSTEMS) {
    // Each check must short-circuit before the next runs, exactly like the five hardcoded `if`s this replaces; there is nothing to parallelise since a later check's own relevance depends on nothing evaluated here, but ordering (which check is reported as "the" failure) is observable and must match history.
    const result = await trileanEvaluatePredicate(
      delegateIsTrue(system),
      context,
      resolvers,
    );
    if (result.status !== "definite" || !result.value) {
      return system;
    }
  }
  return undefined;
}

export type ConditionsVerdict =
  { ok: true } | { ok: false; reason: "not_satisfied" };

/**
 * Evaluates token-claims' own `conditions` field (issue #85): additional, issuer-chosen predicates strictly additive to the five mandatory narrowing checks above, which are computed structurally (from a delegated token's own claims and its parent's) and never read from this field -- the five built-ins are inherently about a parent/child relationship, so they are not meaningfully reusable inside a bare, parent-less conditions evaluation, unlike a genuine domain-specific condition (a message TTL, #84's future revoke-authorization check) which reasons about the presented token's own claims directly. `extraHandlers` is the registration point for those: none exist yet, so a `conditions` entry naming any system with no registered handler resolves `{found: false}` -- indeterminate, fail-closed. Absent `nodes` (an empty array, the caller's own signal for "no conditions field present") is trivially `{ok: true}` -- no extra restrictions, exactly today's behaviour. Every entry MUST evaluate to a definite `true`; the loop short-circuits on the first indeterminate or false result.
 */
export async function evaluateConditions(
  nodes: readonly PredicateNode[],
  claims: Readonly<TokenClaims>,
  clock: Readonly<Clock>,
  extraHandlers: Readonly<
    Record<string, TokenDelegateHandler<ConditionsContext>>
  > = {},
): Promise<ConditionsVerdict> {
  const context: ConditionsContext = { clock, claims };
  const resolvers: Readonly<Resolvers> = {
    resolveValue: unusedResolveValue,
    resolveLookup: unusedResolveLookup,
    resolveCollection: unusedResolveCollection,
    resolveDelegate: async (system, payload) => {
      // Object.hasOwn guards against a peer-chosen system name (e.g. "__proto__", "constructor", "toString") resolving to an inherited Object.prototype member instead of undefined -- a bare extraHandlers[system] lookup on a plain object would treat that inherited value as a real handler, and "__proto__" specifically isn't even callable, so invoking it throws rather than producing a verdict. The try/catch below is defence in depth for the same fail-closed requirement, covering a genuinely registered handler that throws for its own reasons -- hostile or malformed input to a condition evaluator must always produce a verdict, never propagate an exception, matching verifyTokenChain's own documented convention.
      const handler = Object.hasOwn(extraHandlers, system)
        ? extraHandlers[system]
        : undefined;
      if (handler === undefined) return { found: false };
      try {
        return await handler(payload, context);
      } catch {
        return { found: false };
      }
    },
  };
  for (const node of nodes) {
    // Fail-closed short-circuit: the first unsatisfied condition refuses the whole token, so there is nothing to gain from evaluating the rest.
    const result = await trileanEvaluatePredicate(node, context, resolvers);
    if (result.status !== "definite" || !result.value) {
      return { ok: false, reason: "not_satisfied" };
    }
  }
  return { ok: true };
}
