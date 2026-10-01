// Token vectors kept out of generate.ts the same way adverts.ts already is: generate.ts
// sits at this repo's own max-lines cap, so when a set of token vectors grows the file it
// moves here instead. Everything shared with generate.ts (the synthetic identities, the
// signature filler, the CDE hex encoders) arrives via the context parameter rather than
// being redefined here, so the two files cannot drift apart on what deviceB or a filler
// signature is.

import { encode, cdeEncodeOptions } from "cbor2";
import { hex, type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";

/** The synthetic identities and encoders generate.ts already defines, as one object so this file adds no second copy of them. */
export interface TokenVectorContext {
  readonly deviceA: JsonWire;
  readonly deviceB: JsonWire;
  readonly deviceC: JsonWire;
  readonly deviceAHex: string;
  readonly deviceBHex: string;
  readonly publicKeyEs256A: JsonWire;
  readonly publicKeyEs256B: JsonWire;
  readonly signatureFiller: JsonWire;
  readonly wireHex: (message: JsonWire) => string;
  /** The int-keyed COSE protected header for a device's tokens, as a hex marker. */
  readonly protectedHeaderHex: (device: JsonWire) => string;
  /** Opaque token-id length, arbitrarily sized like a UUID. */
  readonly tokenIdByteLength: number;
}

export function grantTokenVectors(ctx: Readonly<TokenVectorContext>): Vector[] {
  const vector = (name: string, message: JsonWire): Vector => ({
    name,
    message,
    wire_hex: ctx.wireHex(message),
  });
  const token = (
    issuer: JsonWire,
    issuerKey: JsonWire,
    claims: JsonWire,
  ): JsonWire => [
    hex(ctx.protectedHeaderHex(issuer)),
    {},
    hex(ctx.wireHex(claims)),
    ctx.signatureFiller,
  ];

  // The named no-self-grant bar, the exact node shape the TS core's noSelfGrantBar
  // builds: not(and(granted-capability-is "exec:pty", grantee-is <deviceB-hex>)).
  const noSelfGrantBar = {
    kind: "not",
    operand: {
      kind: "and",
      left: {
        kind: "compare",
        op: "eq",
        left: {
          kind: "delegate",
          system: "granted-capability-is",
          payload: "exec:pty",
        },
        right: { kind: "booleanLiteral", value: true },
      },
      right: {
        kind: "compare",
        op: "eq",
        left: {
          kind: "delegate",
          system: "grantee-is",
          payload: ctx.deviceBHex,
        },
        right: { kind: "booleanLiteral", value: true },
      },
    },
  };
  const noSelfGrantBarBytes = Buffer.from(
    encode([noSelfGrantBar], cdeEncodeOptions),
  ).toString("hex");

  // A manage:grant root (deviceA grants deviceB the right to mint, any verb within
  // /work since grants-capability is absent, one hop deep) carrying that bar, then an
  // exec:pty token deviceB minted under it (citing it via authorised-by, granted to
  // deviceC so the bar holds), and a second-level manage:grant deviceB passed onward to
  // deviceC, itself naming exec:pty.
  const manageGrantRootTokenVector = vector(
    "capability_token_v1_manage_grant_root",
    token(ctx.deviceA, ctx.publicKeyEs256A, {
      "token-id": hex("05".repeat(ctx.tokenIdByteLength)),
      issuer: ctx.deviceA,
      "issuer-key": { alg: -7, "public-key": ctx.publicKeyEs256A },
      bearer: ctx.deviceB,
      capability: "manage:grant",
      scope: { kind: "folder", path: "/work" },
      expires: 1893456000000,
      "delegations-remaining": 1,
      conditions: hex(noSelfGrantBarBytes),
    }),
  );

  const grantAuthorisedTokenVector = vector(
    "capability_token_v1_grant_authorised_exec_pty",
    token(ctx.deviceB, ctx.publicKeyEs256B, {
      "token-id": hex("06".repeat(ctx.tokenIdByteLength)),
      issuer: ctx.deviceB,
      "issuer-key": { alg: -7, "public-key": ctx.publicKeyEs256B },
      bearer: ctx.deviceC,
      capability: "exec:pty",
      scope: { kind: "folder", path: "/work/subdir" },
      expires: 1861920000000,
      "authorised-by": hex(manageGrantRootTokenVector.wire_hex),
      "delegations-remaining": 0,
    }),
  );

  const manageGrantDelegatedTokenVector = vector(
    "capability_token_v1_manage_grant_delegated",
    token(ctx.deviceB, ctx.publicKeyEs256B, {
      "token-id": hex("07".repeat(ctx.tokenIdByteLength)),
      issuer: ctx.deviceB,
      "issuer-key": { alg: -7, "public-key": ctx.publicKeyEs256B },
      bearer: ctx.deviceC,
      capability: "manage:grant",
      scope: { kind: "folder", path: "/work" },
      expires: 1861920000000,
      "grants-capability": "exec:pty",
      "authorised-by": hex(manageGrantRootTokenVector.wire_hex),
      "delegations-remaining": 0,
    }),
  );

  return [
    manageGrantRootTokenVector,
    grantAuthorisedTokenVector,
    manageGrantDelegatedTokenVector,
  ];
}

/// core/room's own membership chain demonstrating delegations-remaining: the owner
/// (deviceA) issues a root grant to deviceB capped at one further re-delegation, and
/// deviceB narrows it (a strictly lower value, 0) when re-delegating to deviceC, whose
/// own token therefore bears no further-delegation authority at all.
export function roomMemberTokens(ctx: Readonly<TokenVectorContext>): {
  vectors: Vector[];
  /** The root room:member token's own JsonWire shape, for vectors that embed it (a room-notice's posting authority, a manage-request's presented token). */
  rootToken: JsonWire;
  delegatedToken: JsonWire;
} {
  const vector = (name: string, message: JsonWire): Vector => ({
    name,
    message,
    wire_hex: ctx.wireHex(message),
  });
  const token = (issuer: JsonWire, claims: JsonWire): JsonWire => [
    hex(ctx.protectedHeaderHex(issuer)),
    {},
    hex(ctx.wireHex(claims)),
    ctx.signatureFiller,
  ];
  const roomPath = `${ctx.deviceAHex}/general`;

  const root = vector(
    "capability_token_v1_room_member_root_grant",
    token(ctx.deviceA, {
      "token-id": hex("03".repeat(ctx.tokenIdByteLength)),
      issuer: ctx.deviceA,
      "issuer-key": { alg: -7, "public-key": ctx.publicKeyEs256A },
      bearer: ctx.deviceB,
      capability: "room:member",
      scope: { kind: "room", path: roomPath },
      expires: 1893456000000,
      "delegations-remaining": 1,
    }),
  );

  const delegated = vector(
    "capability_token_v1_room_member_delegated_no_further_delegation",
    token(ctx.deviceB, {
      "token-id": hex("04".repeat(ctx.tokenIdByteLength)),
      issuer: ctx.deviceB,
      "issuer-key": { alg: -7, "public-key": ctx.publicKeyEs256B },
      bearer: ctx.deviceC,
      capability: "room:member",
      scope: { kind: "room", path: roomPath },
      expires: 1861920000000,
      parent: hex(root.wire_hex),
      "delegations-remaining": 0,
    }),
  );

  return {
    vectors: [root, delegated],
    rootToken: root.message,
    delegatedToken: delegated.message,
  };
}

/// wire-mesh#324's request-permission root: deviceA grants deviceB the right to ASK for
/// room:member over any room (a path-less room scope is the kind's whole root, so the
/// token's scope covers any room path a request might carry). Presented in
/// manage-request-frame's own token field; the gated frame vector below embeds exactly
/// these wire bytes.
export function manageRequestTokenVector(
  ctx: Readonly<TokenVectorContext>,
): Vector {
  const vector = (name: string, message: JsonWire): Vector => ({
    name,
    message,
    wire_hex: ctx.wireHex(message),
  });
  return vector("capability_token_v1_manage_request_root", [
    hex(ctx.protectedHeaderHex(ctx.deviceA)),
    {},
    hex(
      ctx.wireHex({
        "token-id": hex("08".repeat(ctx.tokenIdByteLength)),
        issuer: ctx.deviceA,
        "issuer-key": { alg: -7, "public-key": ctx.publicKeyEs256A },
        bearer: ctx.deviceB,
        capability: "manage:request",
        scope: { kind: "room" },
        expires: 1893456000000,
        "requests-capability": "room:member",
      }),
    ),
    ctx.signatureFiller,
  ]);
}
