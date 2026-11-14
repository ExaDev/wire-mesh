/* Checks every case of conformance/mint.v1.json against the real mintCapabilityToken, mintRevocationEntry, canGrant and canGrantVia. The schemas are strict, so a key this test does not read fails it. In summary:

   - each identity's public key and device-id is derived from its seed;
   - each minting case is run: a token that must mint is compared byte for byte with the vector, and a refusal is compared with the reason the vector expects;
   - every token the vectors mint verifies with verifyCapabilityToken at the file's clock;
   - each revocation entry is minted byte for byte and is admitted by verifyRevocationEntry;
   - each canGrant and canGrantVia query gives the verdict the vector states.

   Not compared, because they only name: every `name`, `synthetic` and the layout version (checked to be the one this test reads). */

import { createPrivateKey, createPublicKey, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import {
  canGrant,
  canGrantVia,
  mintCapabilityToken,
  mintRevocationEntry,
  verifyCapabilityToken,
  verifyRevocationEntry,
} from "../src/domain/tokens.js";
import type { MintRefusalReason } from "../src/domain/tokens.js";
import { conditionsListSchema } from "../src/domain/token-predicates.js";
import {
  capabilityTokenSchema,
  type CapabilityToken,
} from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import { bytesFromHex } from "./hex.js";
import { fixedClock, neverRevoked } from "./tokens-fixtures.js";

const EDDSA = -8;
const LAYOUT_VERSION = 1;
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";

const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/);
/** An integer as a JavaScript number holds it, not only a safe one: the file carries a value at 2^53 for the cases only Rust runs. */
const integer = z.number().refine(Number.isInteger);
const scopeSchema = z.strictObject({
  kind: z.string(),
  path: z.string().optional(),
});
const candidateSchema = z.strictObject({
  capability: z.string(),
  scope: scopeSchema,
  expires: integer,
  delegations_remaining: integer.nullable(),
});

const mintCaseSchema = z.strictObject({
  name: z.string(),
  issuer: z.string(),
  now_ms: z.number().int(),
  token_id_hex: hexString,
  bearer: z.string(),
  capability: z.string(),
  scope: scopeSchema,
  expires: integer,
  not_before: integer.nullable(),
  delegations_remaining: integer.nullable(),
  conditions_hex: hexString.nullable(),
  parent_wire_hex: hexString.nullable(),
  authorised_by_wire_hex: hexString.nullable(),
  grants_capability: z.string().nullable(),
  requests_capability: z.string().nullable(),
  rust_only: z.boolean(),
  expected: z.discriminatedUnion("result", [
    z.strictObject({
      result: z.literal("minted"),
      vector: z.string(),
      verifies: z.boolean(),
    }),
    z.strictObject({ result: z.literal("refused"), reason: z.string() }),
  ]),
});

const grantQuerySchema = z.strictObject({
  name: z.string(),
  held_wire_hex: hexString,
  device: z.string(),
  candidate: candidateSchema,
  now_ms: z.number().int(),
  expected: z.boolean(),
});

const file = z
  .object({
    vectors: z.array(z.object({ name: z.string(), wire_hex: hexString })),
    mint: z.strictObject({
      layout_version: z.literal(LAYOUT_VERSION),
      now_ms: z.number().int(),
      identities: z.record(
        z.string(),
        z.strictObject({
          alg: z.number().int(),
          synthetic: z.literal(true),
          secret_hex: hexString,
          public_key_hex: hexString,
          device_id_hex: hexString,
        }),
      ),
      token_mints: z.array(mintCaseSchema),
      revocation_mints: z.array(
        z.strictObject({
          name: z.string(),
          issuer: z.string(),
          token_id_hex: hexString,
          revoked_at: z.number().int(),
          vector: z.string(),
        }),
      ),
      can_grant: z.array(grantQuerySchema),
      can_grant_via: z.array(
        grantQuerySchema.extend({ candidate_bearer: z.string() }),
      ),
      counts: z.strictObject({
        token_mints: z.number().int(),
        revocation_mints: z.number().int(),
        can_grant: z.number().int(),
        can_grant_via: z.number().int(),
      }),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../../../conformance/mint.v1.json", import.meta.url),
        ),
        "utf8",
      ),
    ),
  );
const section = file.mint;

function wireOfVector(name: string): string {
  const found = file.vectors.find((vector) => vector.name === name);
  if (found === undefined) {
    throw new Error(`vector file has no vector ${name}`);
  }

  return found.wire_hex;
}

function tokenFromWire(wireHex: string): CapabilityToken {
  return capabilityTokenSchema.parse(
    decode(bytesFromHex(wireHex), cdeDecodeOptions),
  );
}

function wireOfToken(token: CapabilityToken): string {
  return Buffer.from(encode(token, cdeEncodeOptions)).toString("hex");
}

const ports = new Map<string, Promise<IdentityPort>>();

/** The identity whose seed the file records, able to sign. */
async function identityPort(name: string): Promise<IdentityPort> {
  const held = ports.get(name);
  if (held !== undefined) {
    return held;
  }
  const identity = section.identities[name];
  if (identity === undefined) {
    throw new Error(`vector file has no identity ${name}`);
  }
  const pending = (async () => {
    const privateKey = createPrivateKey({
      key: Buffer.from(PKCS8_ED25519_PREFIX + identity.secret_hex, "hex"),
      format: "der",
      type: "pkcs8",
    });
    const jwk = createPublicKey(privateKey).export({ format: "jwk" });
    if (typeof jwk.x !== "string") {
      throw new Error("no public key");
    }
    const cryptoKey = await webcrypto.subtle.importKey(
      "pkcs8",
      privateKey.export({ format: "der", type: "pkcs8" }),
      { name: "Ed25519" },
      false,
      ["sign"],
    );

    return createNodeIdentity(
      cryptoKey,
      Buffer.from(jwk.x, "base64url"),
      EDDSA,
    );
  })();
  ports.set(name, pending);

  return pending;
}

async function deviceOf(name: string): Promise<Uint8Array<ArrayBuffer>> {
  return Uint8Array.from((await identityPort(name)).deviceId);
}

function narrowing(candidate: z.infer<typeof candidateSchema>) {
  return {
    capability: candidate.capability,
    scope:
      candidate.scope.path === undefined
        ? { kind: candidate.scope.kind }
        : { kind: candidate.scope.kind, path: candidate.scope.path },
    expires: candidate.expires,
    ...(candidate.delegations_remaining === null
      ? {}
      : { delegationsRemaining: candidate.delegations_remaining }),
  };
}

describe("mint identities", () => {
  for (const [name, identity] of Object.entries(section.identities)) {
    it(`${name} has the key and device-id its seed gives`, async () => {
      const port = await identityPort(name);

      expect(Buffer.from(port.identityKey["public-key"]).toString("hex")).toBe(
        identity.public_key_hex,
      );
      expect(Buffer.from(port.deviceId).toString("hex")).toBe(
        identity.device_id_hex,
      );
    });
  }
});

/** The refusal reasons the TypeScript core can give, every one of which has a case in the file. The reason only an implementation with a Rust-sized integer gives is left out. */
const TYPESCRIPT_REASONS = [
  "already_expired",
  "invalid_capability",
  "parent_malformed",
  "parent_bearer_mismatch",
  "expires_exceeds_parent",
  "scope_does_not_narrow",
  "capability_mismatch",
  "delegation_exceeds_parent",
  "links_exclusive",
  "authorisation_malformed",
  "authorisation_parent_forbidden",
  "authorisation_bearer_mismatch",
  "authorisation_capability_mismatch",
  "authorisation_scope_does_not_narrow",
  "authorisation_exceeds_authoriser",
  "authorisation_delegation_exceeds",
  "authorisation_conditions_not_satisfied",
] as const satisfies readonly MintRefusalReason[];

describe("the file's own accounting", () => {
  it("holds the number of cases its header says", () => {
    expect(section.token_mints).toHaveLength(section.counts.token_mints);
    expect(section.revocation_mints).toHaveLength(
      section.counts.revocation_mints,
    );
    expect(section.can_grant).toHaveLength(section.counts.can_grant);
    expect(section.can_grant_via).toHaveLength(section.counts.can_grant_via);
  });

  it("has a case for every refusal reason, and flags as Rust-only exactly the cases that expect the Rust-only reason", () => {
    const expected = new Set(
      section.token_mints.flatMap((testCase) =>
        testCase.expected.result === "refused"
          ? [testCase.expected.reason]
          : [],
      ),
    );
    for (const reason of TYPESCRIPT_REASONS) {
      expect(expected, reason).toContain(reason);
    }
    for (const testCase of section.token_mints) {
      expect(testCase.rust_only, testCase.name).toBe(
        testCase.expected.result === "refused" &&
          testCase.expected.reason === "value_not_representable",
      );
    }
  });
});

describe("mintCapabilityToken", () => {
  for (const testCase of section.token_mints.filter((c) => !c.rust_only)) {
    it(testCase.name, async () => {
      const issuer = await identityPort(testCase.issuer);
      const scope =
        testCase.scope.path === undefined
          ? { kind: testCase.scope.kind }
          : { kind: testCase.scope.kind, path: testCase.scope.path };
      const verdict = await mintCapabilityToken({
        identity: issuer,
        clock: fixedClock(testCase.now_ms),
        tokenId: bytesFromHex(testCase.token_id_hex),
        bearer: await deviceOf(testCase.bearer),
        capability: testCase.capability,
        scope,
        expires: testCase.expires,
        ...(testCase.not_before === null
          ? {}
          : { notBefore: testCase.not_before }),
        ...(testCase.delegations_remaining === null
          ? {}
          : { delegationsRemaining: testCase.delegations_remaining }),
        ...(testCase.conditions_hex === null
          ? {}
          : {
              conditions: conditionsListSchema.parse(
                decode(bytesFromHex(testCase.conditions_hex), cdeDecodeOptions),
              ),
            }),
        ...(testCase.parent_wire_hex === null
          ? {}
          : { parent: tokenFromWire(testCase.parent_wire_hex) }),
        ...(testCase.authorised_by_wire_hex === null
          ? {}
          : { authorisedBy: tokenFromWire(testCase.authorised_by_wire_hex) }),
        ...(testCase.grants_capability === null
          ? {}
          : { grantsCapability: testCase.grants_capability }),
        ...(testCase.requests_capability === null
          ? {}
          : { requestsCapability: testCase.requests_capability }),
      });

      if (testCase.expected.result === "refused") {
        expect(verdict).toEqual({
          ok: false,
          reason: testCase.expected.reason,
        });

        return;
      }
      expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
      if (!verdict.ok) {
        return;
      }
      expect(wireOfToken(verdict.token)).toBe(
        wireOfVector(testCase.expected.vector),
      );
      const verified = await verifyCapabilityToken(verdict.token, {
        identity: issuer,
        clock: fixedClock(section.now_ms),
        revocation: neverRevoked,
      });
      expect(verified.ok, JSON.stringify(verified)).toBe(
        testCase.expected.verifies,
      );
    });
  }
});

describe("mintRevocationEntry", () => {
  for (const testCase of section.revocation_mints) {
    it(testCase.name, async () => {
      const issuer = await identityPort(testCase.issuer);
      const entry = await mintRevocationEntry({
        identity: issuer,
        tokenId: bytesFromHex(testCase.token_id_hex),
        revokedAt: testCase.revoked_at,
      });

      expect(wireOfToken(entry)).toBe(wireOfVector(testCase.vector));
      expect(
        (await verifyRevocationEntry(entry, { identity: issuer })).ok,
      ).toBe(true);
    });
  }
});

describe("canGrant", () => {
  for (const query of section.can_grant) {
    it(query.name, async () => {
      const verdict = await canGrant(
        tokenFromWire(query.held_wire_hex),
        await deviceOf(query.device),
        narrowing(query.candidate),
        query.now_ms,
      );

      expect(verdict).toBe(query.expected);
    });
  }
});

describe("canGrantVia", () => {
  for (const query of section.can_grant_via) {
    it(query.name, async () => {
      const verdict = await canGrantVia(
        tokenFromWire(query.held_wire_hex),
        await deviceOf(query.device),
        {
          ...narrowing(query.candidate),
          bearer: await deviceOf(query.candidate_bearer),
        },
        query.now_ms,
      );

      expect(verdict).toBe(query.expected);
    });
  }
});
