import { cdeEncodeOptions, decode, encode } from "cbor2";
import { beforeAll, describe, expect, it } from "vitest";
import {
  mintCapabilityToken,
  verifyCapabilityToken,
} from "../src/domain/tokens.js";
import type {
  ConditionsContext,
  TokenDelegateHandler,
} from "../src/domain/token-predicates.js";
import type { IdentityPort } from "../src/ports/identity.js";
import {
  tokenClaimsSchema,
  type CapabilityScope,
  type CapabilityToken,
  type TokenClaims,
} from "../src/generated/protocol.js";
import {
  HOUR_MS,
  buf,
  encodeBuf,
  fixedClock,
  generateEs256Identity,
  neverRevoked,
  nextTokenId,
} from "./tokens-fixtures.js";

/** Signs a root capability token whose own `conditions` field is exactly `conditionsBytes` -- unlike tampering with an already-signed token's payload (which would fail signature verification before conditions are ever decoded), this signs over the malformed bytes directly, so a test using it actually exercises the conditions-decode path rather than bad_signature. */
async function signTokenWithRawConditions(
  identity: IdentityPort,
  conditionsBytes: Uint8Array,
  seed: {
    tokenId: Uint8Array<ArrayBuffer>;
    scope: CapabilityScope;
    expires: number;
  },
): Promise<CapabilityToken> {
  const claims: TokenClaims = {
    "token-id": seed.tokenId,
    issuer: identity.deviceId,
    "issuer-key": identity.identityKey,
    bearer: identity.deviceId,
    capability: "exec:pty",
    scope: seed.scope,
    expires: seed.expires,
    conditions: buf(conditionsBytes),
  };
  const payload = encodeBuf(claims);
  const protectedHeader = encodeBuf({});
  const toBeSigned = encodeBuf([
    "Signature1",
    protectedHeader,
    new Uint8Array(0),
    payload,
  ]);
  const signature = await identity.sign(toBeSigned);
  return [protectedHeader, {}, payload, signature];
}

// 0xff repeated three times is not a valid CBOR encoding of anything -- the exact byte value doesn't matter beyond that, only that it fails to decode.
const INVALID_CBOR_BYTE = 0xff;
const INVALID_CBOR_BYTES = new Uint8Array([
  INVALID_CBOR_BYTE,
  INVALID_CBOR_BYTE,
  INVALID_CBOR_BYTE,
]);

describe("token-claims.conditions -- the generic predicate-list evaluator", () => {
  let issuer: IdentityPort;
  const now = 1_893_456_000_000;
  const workScope: CapabilityScope = { kind: "folder", path: "/work" };

  beforeAll(async () => {
    issuer = await generateEs256Identity();
  });

  it("verifies a root token that carries no conditions field at all, unchanged from before this field existed", async () => {
    const minted = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.token[2]).not.toBeNull();
    if (minted.token[2] === null) return;
    const decodedClaims = tokenClaimsSchema.parse(decode(minted.token[2]));
    expect(decodedClaims.conditions).toBeUndefined();

    const verdict = await verifyCapabilityToken(minted.token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });
    expect(verdict.ok).toBe(true);
  });

  // A genuinely non-hardcoded, domain-defined predicate -- not one of the five built-in narrowing ops -- registered only for this test via extraPredicateResolvers, proving the mechanism generalises to conditions no wire-mesh-core code knows about in advance.
  const ABOVE_THRESHOLD = "x-test:above-threshold";

  interface ThresholdPayload {
    readonly value: number;
    readonly threshold: number;
  }

  function isThresholdPayload(payload: unknown): payload is ThresholdPayload {
    if (typeof payload !== "object" || payload === null) return false;
    if (!("value" in payload) || !("threshold" in payload)) return false;
    return (
      typeof payload.value === "number" && typeof payload.threshold === "number"
    );
  }

  const aboveThresholdHandler: TokenDelegateHandler<ConditionsContext> = (
    payload,
  ) => {
    if (!isThresholdPayload(payload)) {
      return { found: false };
    }
    return {
      found: true,
      value: { kind: "boolean", value: payload.value > payload.threshold },
    };
  };

  it("accepts a token whose custom condition is satisfied, via a caller-registered delegate system", async () => {
    const minted = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
      conditions: [
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "delegate",
            system: ABOVE_THRESHOLD,
            payload: { value: 10, threshold: 5 },
          },
          right: { kind: "booleanLiteral", value: true },
        },
      ],
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const verdict = await verifyCapabilityToken(minted.token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
      extraPredicateResolvers: { [ABOVE_THRESHOLD]: aboveThresholdHandler },
    });
    expect(verdict.ok).toBe(true);
  });

  it("rejects a token whose custom condition is not satisfied, via the same caller-registered delegate system", async () => {
    const minted = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
      conditions: [
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "delegate",
            system: ABOVE_THRESHOLD,
            payload: { value: 2, threshold: 5 },
          },
          right: { kind: "booleanLiteral", value: true },
        },
      ],
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const verdict = await verifyCapabilityToken(minted.token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
      extraPredicateResolvers: { [ABOVE_THRESHOLD]: aboveThresholdHandler },
    });
    expect(verdict).toEqual({ ok: false, reason: "conditions_not_satisfied" });
  });

  it("fails closed (conditions_not_satisfied) when the verifier has no handler registered for the condition's own delegate system", async () => {
    const minted = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
      conditions: [
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "delegate",
            system: ABOVE_THRESHOLD,
            payload: { value: 10, threshold: 5 },
          },
          right: { kind: "booleanLiteral", value: true },
        },
      ],
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    // No extraPredicateResolvers given -- the verifier cannot resolve ABOVE_THRESHOLD, so the delegate node is indeterminate and the whole token is refused, never silently accepted.
    const verdict = await verifyCapabilityToken(minted.token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });
    expect(verdict).toEqual({ ok: false, reason: "conditions_not_satisfied" });
  });

  it("fails closed rather than throwing when a condition's delegate system names an inherited Object.prototype property", async () => {
    // "constructor" resolves to Object on a plain {} extraHandlers table with no own-property guard -- a peer choosing this system name over ABOVE_THRESHOLD's own, deliberately unregistered name is exactly the attack Codex's own review flagged: a bare `extraHandlers[system]` lookup treats an inherited prototype member as a real handler, and invoking it throws instead of producing a verdict.
    const minted = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
      conditions: [
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "delegate",
            system: "constructor",
            payload: { value: 10, threshold: 5 },
          },
          right: { kind: "booleanLiteral", value: true },
        },
      ],
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const verdict = await verifyCapabilityToken(minted.token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });
    expect(verdict).toEqual({ ok: false, reason: "conditions_not_satisfied" });
  });

  it("fails closed rather than throwing when a condition's delegate system is __proto__ itself", async () => {
    // extraHandlers["__proto__"] on a plain {} returns Object.prototype -- not a function, so invoking it (`extra(payload, context)`) throws "extra is not a function" rather than returning a verdict, crashing the whole verification call instead of refusing the token.
    const minted = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
      conditions: [
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "delegate",
            system: "__proto__",
            payload: {},
          },
          right: { kind: "booleanLiteral", value: true },
        },
      ],
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const verdict = await verifyCapabilityToken(minted.token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });
    expect(verdict).toEqual({ ok: false, reason: "conditions_not_satisfied" });
  });

  it("rejects a validly-signed token whose conditions bstr does not decode as CBOR", async () => {
    const token = await signTokenWithRawConditions(issuer, INVALID_CBOR_BYTES, {
      tokenId: nextTokenId(),
      scope: workScope,
      expires: now + HOUR_MS,
    });

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });
    expect(verdict).toEqual({ ok: false, reason: "conditions_invalid" });
  });

  it("rejects a validly-signed token whose conditions bstr decodes to something that is not a valid trilean predicate array", async () => {
    // Well-formed CBOR, but not an array of predicate-nodes -- a bare {} has no "kind".
    const notPredicateNodes = encode(
      [{ not: "a predicate node" }],
      cdeEncodeOptions,
    );
    const token = await signTokenWithRawConditions(issuer, notPredicateNodes, {
      tokenId: nextTokenId(),
      scope: workScope,
      expires: now + HOUR_MS,
    });

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });
    expect(verdict).toEqual({ ok: false, reason: "conditions_invalid" });
  });
});
