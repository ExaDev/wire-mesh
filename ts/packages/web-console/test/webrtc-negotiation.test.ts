import { describe, expect, it } from "vitest";
import { cdeEncodeOptions, encode } from "cbor2";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  IceCandidateInit,
  ManageCommand,
  TokenClaims,
} from "@exadev/wire-mesh-core/generated/protocol";
import type { IdentityPort } from "@exadev/wire-mesh-core/ports/identity";
import type { Clock } from "@exadev/wire-mesh-core/ports/clock";
import type { RevocationCheck } from "@exadev/wire-mesh-core/domain/tokens";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import type { IncomingManageRequest } from "../src/mesh-session.js";
import {
  WEBRTC_SIGNAL_SCOPE,
  WEBRTC_SIGNAL_VERB,
  authorizeIncomingOffer,
  buildAnswerCommand,
  buildIceCandidateCommand,
  buildOfferCommand,
  createNegotiationIdAllocator,
  rtcIceCandidateInitFromWire,
  wireIceCandidateFromRtc,
  type MinimalRtcIceCandidate,
} from "../src/webrtc-negotiation.js";

const HOUR_MS = 3_600_000;
const NEGOTIATION_ID = 42;
const TEST_SDP = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n";
const LOW_BYTE_MASK = 0xff;

describe("createNegotiationIdAllocator", () => {
  it("allocates a fresh, independent, sequential id sequence starting at 0", () => {
    const allocate = createNegotiationIdAllocator();
    expect(allocate()).toBe(0);
    expect(allocate()).toBe(1);
    expect(allocate()).toBe(2);
  });

  it("gives each allocator its own independent counter", () => {
    const first = createNegotiationIdAllocator();
    const second = createNegotiationIdAllocator();
    expect(first()).toBe(0);
    expect(first()).toBe(1);
    expect(second()).toBe(0);
  });
});

describe("buildOfferCommand / buildAnswerCommand / buildIceCandidateCommand", () => {
  it("builds a webrtc.offer command carrying the capability verb, negotiation-id, and sdp", () => {
    expect(buildOfferCommand(NEGOTIATION_ID, TEST_SDP)).toEqual({
      verb: WEBRTC_SIGNAL_VERB,
      params: {
        verb: "webrtc.offer",
        "negotiation-id": NEGOTIATION_ID,
        sdp: TEST_SDP,
      },
    } satisfies ManageCommand);
  });

  it("builds a webrtc.answer command carrying the capability verb, negotiation-id, and sdp", () => {
    expect(buildAnswerCommand(NEGOTIATION_ID, TEST_SDP)).toEqual({
      verb: WEBRTC_SIGNAL_VERB,
      params: {
        verb: "webrtc.answer",
        "negotiation-id": NEGOTIATION_ID,
        sdp: TEST_SDP,
      },
    } satisfies ManageCommand);
  });

  it("builds a webrtc.ice-candidate command carrying a candidate when given one", () => {
    const candidate: IceCandidateInit = {
      candidate: "candidate:1 1 UDP 1 192.0.2.1 4433 typ host",
      "sdp-mid": "0",
      "sdp-m-line-index": 0,
    };
    expect(buildIceCandidateCommand(NEGOTIATION_ID, candidate)).toEqual({
      verb: WEBRTC_SIGNAL_VERB,
      params: {
        verb: "webrtc.ice-candidate",
        "negotiation-id": NEGOTIATION_ID,
        candidate,
      },
    } satisfies ManageCommand);
  });

  it("builds a webrtc.ice-candidate command with no candidate field for the end-of-candidates signal", () => {
    const command = buildIceCandidateCommand(NEGOTIATION_ID);
    expect(command).toEqual({
      verb: WEBRTC_SIGNAL_VERB,
      params: {
        verb: "webrtc.ice-candidate",
        "negotiation-id": NEGOTIATION_ID,
      },
    } satisfies ManageCommand);
    expect("candidate" in command.params).toBe(false);
  });
});

describe("wireIceCandidateFromRtc", () => {
  it("carries every non-null field across to its wire kebab-case name", () => {
    const candidate: MinimalRtcIceCandidate = {
      candidate: "candidate:1 1 UDP 1 192.0.2.1 4433 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "abcd",
    };
    expect(wireIceCandidateFromRtc(candidate)).toEqual({
      candidate: candidate.candidate,
      "sdp-mid": "0",
      "sdp-m-line-index": 0,
      "username-fragment": "abcd",
    } satisfies IceCandidateInit);
  });

  it("omits fields that are null rather than carrying a null value across", () => {
    const candidate: MinimalRtcIceCandidate = {
      candidate: "candidate:1 1 UDP 1 192.0.2.1 4433 typ host",
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null,
    };
    expect(wireIceCandidateFromRtc(candidate)).toEqual({
      candidate: candidate.candidate,
    } satisfies IceCandidateInit);
  });
});

describe("rtcIceCandidateInitFromWire", () => {
  it("carries every present wire field across to its camelCase name", () => {
    const wire: IceCandidateInit = {
      candidate: "candidate:1 1 UDP 1 192.0.2.1 4433 typ host",
      "sdp-mid": "0",
      "sdp-m-line-index": 0,
      "username-fragment": "abcd",
    };
    expect(rtcIceCandidateInitFromWire(wire)).toEqual({
      candidate: wire.candidate,
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "abcd",
    });
  });

  it("omits fields the wire message never carried, round-tripping through wireIceCandidateFromRtc and back", () => {
    const original: MinimalRtcIceCandidate = {
      candidate: "candidate:2 1 UDP 1 192.0.2.2 4434 typ host",
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: null,
    };
    const wire = wireIceCandidateFromRtc(original);
    const roundTripped = rtcIceCandidateInitFromWire(wire);
    expect(roundTripped).toEqual({ candidate: original.candidate });
  });
});

// Token construction mirrors core's own test/tokens.test.ts signToken helper: explicit field-by-field TokenClaims construction (its own .catchall(z.unknown()) index signature makes a spread-based partial lose specific field types), a COSE_Sign1 with an empty protected header, signed via the identity itself.
function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function encodeBuf(value: unknown): Uint8Array<ArrayBuffer> {
  return buf(encode(value, cdeEncodeOptions));
}

let issuedTokenIds = 0;
/** A fresh, distinct token-id per call -- the tests only need each token to be distinguishable from the others, not any particular byte value. */
function nextTokenId(): Uint8Array<ArrayBuffer> {
  issuedTokenIds += 1;
  return buf([issuedTokenIds]);
}

interface TokenSeed {
  tokenId: Uint8Array<ArrayBuffer>;
  bearer: DeviceId;
  capability: string;
  scope: CapabilityScope;
  expires: number;
}

async function signToken(
  identity: IdentityPort,
  seed: Readonly<TokenSeed>,
): Promise<CapabilityToken> {
  const claims: TokenClaims = {
    "token-id": seed.tokenId,
    issuer: identity.deviceId,
    "issuer-key": identity.identityKey,
    bearer: seed.bearer,
    capability: seed.capability,
    scope: seed.scope,
    expires: seed.expires,
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

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

const neverRevoked: RevocationCheck = {
  isRevoked: async () => Promise.resolve(false),
};

function fakeIncomingRequest(
  token: CapabilityToken | undefined,
): IncomingManageRequest {
  return {
    requestId: 0,
    command: { verb: WEBRTC_SIGNAL_VERB, params: { verb: "webrtc.offer" } },
    scope: WEBRTC_SIGNAL_SCOPE,
    ...(token !== undefined ? { token } : {}),
    respond: async (): Promise<void> =>
      Promise.reject(new Error("respond() should not be called in this test")),
  };
}

describe("authorizeIncomingOffer", () => {
  const now = 1_893_456_000_000;

  it("rejects an offer with no token at all", async () => {
    const issuer = await createWebCryptoIdentity();
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(undefined),
      { identity: issuer, clock: fixedClock(now), revocation: neverRevoked },
    );
    expect(authorized).toBe(false);
  });

  it("accepts a validly signed token bearing exactly the webrtc:signal capability over a node-kind scope", async () => {
    const issuer = await createWebCryptoIdentity();
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: WEBRTC_SIGNAL_VERB,
      scope: WEBRTC_SIGNAL_SCOPE,
      expires: now + HOUR_MS,
    });
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(token),
      {
        identity: issuer,
        clock: fixedClock(now),
        revocation: neverRevoked,
      },
    );
    expect(authorized).toBe(true);
  });

  it("rejects a token whose capability is not webrtc:signal", async () => {
    const issuer = await createWebCryptoIdentity();
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: "exec:pty",
      scope: WEBRTC_SIGNAL_SCOPE,
      expires: now + HOUR_MS,
    });
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(token),
      {
        identity: issuer,
        clock: fixedClock(now),
        revocation: neverRevoked,
      },
    );
    expect(authorized).toBe(false);
  });

  it("rejects a token whose scope kind is not node", async () => {
    const issuer = await createWebCryptoIdentity();
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: WEBRTC_SIGNAL_VERB,
      scope: { kind: "folder", path: "/work" },
      expires: now + HOUR_MS,
    });
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(token),
      {
        identity: issuer,
        clock: fixedClock(now),
        revocation: neverRevoked,
      },
    );
    expect(authorized).toBe(false);
  });

  it("rejects an expired token", async () => {
    const issuer = await createWebCryptoIdentity();
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: WEBRTC_SIGNAL_VERB,
      scope: WEBRTC_SIGNAL_SCOPE,
      expires: now - 1,
    });
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(token),
      {
        identity: issuer,
        clock: fixedClock(now),
        revocation: neverRevoked,
      },
    );
    expect(authorized).toBe(false);
  });

  it("rejects a token with a tampered signature", async () => {
    const issuer = await createWebCryptoIdentity();
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: WEBRTC_SIGNAL_VERB,
      scope: WEBRTC_SIGNAL_SCOPE,
      expires: now + HOUR_MS,
    });
    const [protectedHeader, unprotected, payload, signature] = token;
    const tamperedSignature = Uint8Array.from(signature);
    const lastIndex = tamperedSignature.length - 1;
    tamperedSignature[lastIndex] =
      (tamperedSignature[lastIndex] ?? 0) ^ LOW_BYTE_MASK;
    const tamperedToken: CapabilityToken = [
      protectedHeader,
      unprotected,
      payload,
      tamperedSignature,
    ];
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(tamperedToken),
      { identity: issuer, clock: fixedClock(now), revocation: neverRevoked },
    );
    expect(authorized).toBe(false);
  });
});
