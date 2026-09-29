import { afterEach, describe, expect, it, vi } from "vitest";
import { cdeEncodeOptions, encode } from "cbor2";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  TokenClaims,
} from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { RevocationCheck } from "wire-mesh-core/domain/tokens";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import {
  createWebrtcNegotiator,
  mintOfferToken,
} from "../src/webrtc-negotiation.js";
import type {
  IncomingManageRequest,
  MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import {
  WEBRTC_SIGNAL_SCOPE,
  WEBRTC_SIGNAL_VERB,
  authorizeIncomingOffer,
} from "wire-mesh-core/domain/webrtc-signaling";

// createNegotiationIdAllocator, buildOfferCommand/buildAnswerCommand/buildIceCandidateCommand, wireIceCandidateFromRtc, and rtcIceCandidateInitFromWire are pure, DOM-free protocol logic that now lives in wire-mesh-core/domain/webrtc-signaling (see its own test/webrtc-signaling.unit.test.ts): this file re-exports them for this package's own callers but no longer duplicates their tests. What remains here is authorizeIncomingOffer (re-tested against this package's own createWebCryptoIdentity, since core's own equivalent test uses a Node identity adapter instead) and, below, createWebrtcNegotiator's real RTCPeerConnection-driven behaviour, which has no DOM-free counterpart to move.

const HOUR_MS = 3_600_000;
const now = 1_893_456_000_000;
const LOW_BYTE_MASK = 0xff;

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
  entriesFor: async () => Promise.resolve([]),
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

/** The parts of RTCPeerConnection initiate() touches before it sends the offer -- Node has no RTCPeerConnection, so this stands in for it. Nothing here ever opens a channel, so the promise initiate() returns never settles. */
class StubPeerConnection {
  addEventListener(): void {
    return undefined;
  }
  createDataChannel(): { binaryType: string; addEventListener: () => void } {
    return { binaryType: "", addEventListener: () => undefined };
  }
  async createOffer(): Promise<{ sdp: string }> {
    return Promise.resolve({ sdp: "v=0" });
  }
  async setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    return undefined;
  }
}

/** An incoming-request stream that has already ended. */
const noIncomingRequests: AsyncIterable<IncomingManageRequest> = {
  [Symbol.asyncIterator]: () => ({
    next: async () => Promise.resolve({ done: true, value: undefined }),
  }),
};

describe("WebrtcNegotiator.initiate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends its offer with a token the receiving side's own authorizeIncomingOffer accepts", async () => {
    vi.stubGlobal("RTCPeerConnection", StubPeerConnection);
    const initiator = await createWebCryptoIdentity();
    const responder = await createWebCryptoIdentity();
    const clock = fixedClock(now);
    const sendManageRequest = vi.fn<MeshSession["sendManageRequest"]>(
      async () => Promise.resolve({ result: "ok" }),
    );
    const negotiator = createWebrtcNegotiator(
      { sendManageRequest, incomingManageRequests: noIncomingRequests },
      { identity: initiator, clock, onIncomingConnection: () => undefined },
    );

    void negotiator.initiate(responder.deviceId);
    await vi.waitFor(() => {
      expect(sendManageRequest).toHaveBeenCalledTimes(1);
    });

    const [command, , target, token] = sendManageRequest.mock.calls[0] ?? [];
    expect(command?.verb).toBe(WEBRTC_SIGNAL_VERB);
    expect(target).toEqual(responder.deviceId);
    if (token === undefined) throw new Error("the offer carried no token");
    expect(
      await authorizeIncomingOffer(fakeIncomingRequest(token), {
        identity: responder,
        clock,
        revocation: neverRevoked,
      }),
    ).toBe(true);
  });
});

describe("mintOfferToken", () => {
  it("issues a token valid now, expired an hour on, and a fresh token id each time", async () => {
    const identity = await createWebCryptoIdentity();
    const clock = fixedClock(now);

    const first = await mintOfferToken(identity, clock);
    const second = await mintOfferToken(identity, clock);

    expect(first[2]).not.toEqual(second[2]);
    expect(
      await authorizeIncomingOffer(fakeIncomingRequest(first), {
        identity,
        clock,
        revocation: neverRevoked,
      }),
    ).toBe(true);
    for (const token of [first, second]) {
      expect(
        await authorizeIncomingOffer(fakeIncomingRequest(token), {
          identity,
          clock: fixedClock(now + HOUR_MS + 1),
          revocation: neverRevoked,
        }),
      ).toBe(false);
    }
  });
});
