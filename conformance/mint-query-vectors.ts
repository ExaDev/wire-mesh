/* The canGrant and canGrantVia cases of mint.v1.json, with the verdict of each written by hand from tokens.cddl. */

import type { JsonWire } from "@exadev/wire-mesh-conformance";

const EXEC = "exec:pty";
const HALF = 2;
const TWICE = 2;
const TWO_HOPS = 2;
const ONE_HOP = 1;
const NO_HOPS = 0;

interface GrantQueryOptions {
  nowMs?: number;
  held?: string;
}

export interface Scope {
  kind: string;
  path?: string;
}

export function scopeJson(scope: Readonly<Scope>): JsonWire {
  return scope.path === undefined
    ? { kind: scope.kind }
    : { kind: scope.kind, path: scope.path };
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

/** What the cases need of the file they belong to. */
export interface QueryDeps {
  nowMs: number;
  hourMs: number;
  /** The wire hex of a token the file's other cases already minted. */
  held: (name: string) => string;
  /** A cose-sign1 that decodes as a token and has none of its fields. */
  malformedTokenWire: string;
}

export function queryCases(deps: Readonly<QueryDeps>): {
  canGrantCases: JsonWire[];
  viaCases: JsonWire[];
} {
  const NOW_MS = deps.nowMs;
  const HALF_HOUR_MS = deps.hourMs / HALF;
  const TWO_HOURS_MS = TWICE * deps.hourMs;
  const wireOf = deps.held;
  const parent = wireOf("root_grant");
  const grantWire = wireOf("grant_capability_root_with_bar");
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
    options: Readonly<GrantQueryOptions> = {},
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
  const yes = (device: string, candidate: Candidate) => ({
    device,
    candidate,
    expected: true,
  });
  const no = (device: string, candidate: Candidate) => ({
    device,
    candidate,
    expected: false,
  });
  grantQuery("can_grant_a_narrower_delegation", yes("b", delegation));
  grantQuery("can_grant_not_for_another_device", no("c", delegation));
  grantQuery(
    "can_grant_not_a_wider_scope",
    no("b", { ...delegation, scope: { kind: "folder", path: "/other" } }),
  );
  grantQuery(
    "can_grant_not_a_later_expiry",
    no("b", { ...delegation, expires: NOW_MS + TWO_HOURS_MS }),
  );
  grantQuery(
    "can_grant_not_another_verb",
    no("b", { ...delegation, capability: "fs:read" }),
  );
  grantQuery(
    "can_grant_not_the_same_hops",
    no("b", { ...delegation, delegationsRemaining: TWO_HOPS }),
  );
  grantQuery(
    "can_grant_not_an_expired_candidate",
    no("b", { ...delegation, expires: NOW_MS - 1 }),
  );
  grantQuery("can_grant_not_from_a_malformed_token", no("b", delegation), {
    held: deps.malformedTokenWire,
  });

  grantQuery(
    "can_grant_under_the_root_slash",
    yes("b", {
      ...delegation,
      scope: { kind: "folder", path: "/work/x" },
      delegationsRemaining: NO_HOPS,
    }),
    {
      held: wireOf("root_grant_slash_root"),
    },
  );
  grantQuery(
    "can_grant_under_a_trailing_slash",
    yes("b", {
      ...delegation,
      scope: { kind: "folder", path: "/work/sub" },
      delegationsRemaining: NO_HOPS,
    }),
    {
      held: wireOf("root_grant_trailing_slash"),
    },
  );
  grantQuery(
    "can_grant_not_the_parent_name_without_its_slash",
    no("b", {
      ...delegation,
      scope: { kind: "folder", path: "/work" },
      delegationsRemaining: NO_HOPS,
    }),
    {
      held: wireOf("root_grant_trailing_slash"),
    },
  );
  grantQuery(
    "can_grant_not_from_a_token_with_an_invalid_verb",
    no("b", delegation),
    {
      held: wireOf("fixture_token_with_an_invalid_verb"),
    },
  );

  const authorisation: Candidate = {
    ...delegation,
    scope: { kind: "folder", path: "/work/x" },
    delegationsRemaining: NO_HOPS,
  };
  const viaCases: JsonWire[] = [];
  const viaQuery = (
    name: string,
    query: {
      device: string;
      bearer: string;
      candidate: Candidate;
      expected: boolean;
    },
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
  const via = (
    device: string,
    bearer: string,
    candidate: Candidate,
    expected: boolean,
  ) => ({
    device,
    bearer,
    candidate,
    expected,
  });
  viaQuery(
    "can_grant_via_to_another_bearer",
    via("b", "c", authorisation, true),
  );
  viaQuery("can_grant_via_not_to_itself", via("b", "b", authorisation, false));
  viaQuery(
    "can_grant_via_not_for_another_device",
    via("c", "a", authorisation, false),
  );
  viaQuery(
    "can_grant_via_not_another_verb",
    via("b", "c", { ...authorisation, capability: "fs:read" }, false),
  );
  viaQuery(
    "can_grant_via_not_from_a_parentless_token_of_another_verb",
    via("b", "c", authorisation, false),
    wireOf("fixture_authoriser_exec_parentless"),
  );
  viaQuery(
    "can_grant_via_for_any_verb_when_the_grant_names_none",
    via("b", "c", { ...authorisation, capability: "fs:read" }, true),
    wireOf("fixture_grant_for_any_verb"),
  );
  viaQuery(
    "can_grant_via_unbounded_under_an_unbounded_grant",
    via("b", "c", { ...authorisation, delegationsRemaining: null }, true),
    wireOf("fixture_grant_without_a_bound"),
  );
  viaQuery(
    "can_grant_via_not_with_conditions_that_do_not_decode",
    via("b", "c", authorisation, false),
    wireOf("fixture_grant_with_undecodable_conditions"),
  );
  viaQuery(
    "can_grant_via_not_from_a_token_with_a_parent",
    via("b", "c", authorisation, false),
    wireOf("delegation_one_hop"),
  );

  return { canGrantCases, viaCases };
}
