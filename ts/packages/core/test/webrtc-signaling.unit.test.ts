import { describe, expect, it } from "vitest";
import type {
  CapabilityToken,
  IceCandidateInit,
  ManageCommand,
} from "../src/generated/protocol.js";
import type { IncomingManageRequest } from "../src/domain/mesh-session.js";
import {
  WEBRTC_SIGNAL_SCOPE,
  WEBRTC_SIGNAL_VERB,
  authorizeIncomingOffer,
  buildAnswerCommand,
  buildIceCandidateCommand,
  buildOfferCommand,
  buildSfuTrackMapCommand,
  createNegotiationIdAllocator,
  isSfuTrackMap,
  isWebrtcAnswer,
  isWebrtcIceCandidate,
  isWebrtcOffer,
  rtcIceCandidateInitFromWire,
  wireIceCandidateFromRtc,
  type MinimalRtcIceCandidate,
} from "../src/domain/webrtc-signaling.js";
import {
  HOUR_MS,
  fixedClock,
  generateEs256Identity,
  neverRevoked,
  nextTokenId,
  signToken,
} from "./tokens-fixtures.js";

const NEGOTIATION_ID = 42;
const TEST_SDP = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n";
const DEVICE_ID_BYTE_LENGTH = 32; // SHA-256 digest length
const DEVICE_B_FILL_BYTE = 0x22;

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

describe("buildOfferCommand / buildAnswerCommand / buildIceCandidateCommand / buildSfuTrackMapCommand", () => {
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

  it("builds a webrtc.sfu-track-map command carrying the negotiation-id and every track entry", () => {
    const deviceB = Uint8Array.from(
      { length: DEVICE_ID_BYTE_LENGTH },
      () => DEVICE_B_FILL_BYTE,
    );
    const command = buildSfuTrackMapCommand(NEGOTIATION_ID, [
      { mid: "1", member: deviceB, kind: "audio" },
      { mid: "2", member: deviceB, kind: "video" },
    ]);
    expect(command).toEqual({
      verb: WEBRTC_SIGNAL_VERB,
      params: {
        verb: "webrtc.sfu-track-map",
        "negotiation-id": NEGOTIATION_ID,
        tracks: [
          { mid: "1", member: deviceB, kind: "audio" },
          { mid: "2", member: deviceB, kind: "video" },
        ],
      },
    } satisfies ManageCommand);
  });

  it("builds a webrtc.sfu-track-map command with an empty tracks array for a full resend with nothing to report", () => {
    const command = buildSfuTrackMapCommand(NEGOTIATION_ID, []);
    expect(command).toEqual({
      verb: WEBRTC_SIGNAL_VERB,
      params: {
        verb: "webrtc.sfu-track-map",
        "negotiation-id": NEGOTIATION_ID,
        tracks: [],
      },
    } satisfies ManageCommand);
  });
});

describe("isWebrtcOffer / isWebrtcAnswer / isWebrtcIceCandidate / isSfuTrackMap", () => {
  it("narrows only the params shape matching its own verb", () => {
    const offer = buildOfferCommand(NEGOTIATION_ID, TEST_SDP).params;
    const answer = buildAnswerCommand(NEGOTIATION_ID, TEST_SDP).params;
    const iceCandidate = buildIceCandidateCommand(NEGOTIATION_ID).params;
    const trackMap = buildSfuTrackMapCommand(NEGOTIATION_ID, []).params;

    expect(isWebrtcOffer(offer)).toBe(true);
    expect(isWebrtcOffer(answer)).toBe(false);
    expect(isWebrtcAnswer(answer)).toBe(true);
    expect(isWebrtcAnswer(offer)).toBe(false);
    expect(isWebrtcIceCandidate(iceCandidate)).toBe(true);
    expect(isWebrtcIceCandidate(offer)).toBe(false);
    expect(isSfuTrackMap(trackMap)).toBe(true);
    expect(isSfuTrackMap(offer)).toBe(false);
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
    const issuer = await generateEs256Identity();
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(undefined),
      { identity: issuer, clock: fixedClock(now), revocation: neverRevoked },
    );
    expect(authorized).toBe(false);
  });

  it("accepts a validly signed token bearing exactly the webrtc:signal capability over a node-kind scope", async () => {
    const issuer = await generateEs256Identity();
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: WEBRTC_SIGNAL_VERB,
      scope: WEBRTC_SIGNAL_SCOPE,
      expires: now + HOUR_MS,
    });
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(token),
      { identity: issuer, clock: fixedClock(now), revocation: neverRevoked },
    );
    expect(authorized).toBe(true);
  });

  it("rejects a token whose capability is not webrtc:signal", async () => {
    const issuer = await generateEs256Identity();
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: "exec:pty",
      scope: WEBRTC_SIGNAL_SCOPE,
      expires: now + HOUR_MS,
    });
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(token),
      { identity: issuer, clock: fixedClock(now), revocation: neverRevoked },
    );
    expect(authorized).toBe(false);
  });

  it("rejects a token whose scope kind is not node", async () => {
    const issuer = await generateEs256Identity();
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: WEBRTC_SIGNAL_VERB,
      scope: { kind: "folder", path: "/work" },
      expires: now + HOUR_MS,
    });
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(token),
      { identity: issuer, clock: fixedClock(now), revocation: neverRevoked },
    );
    expect(authorized).toBe(false);
  });

  it("rejects an expired token", async () => {
    const issuer = await generateEs256Identity();
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: issuer.deviceId,
      capability: WEBRTC_SIGNAL_VERB,
      scope: WEBRTC_SIGNAL_SCOPE,
      expires: now - 1,
    });
    const authorized = await authorizeIncomingOffer(
      fakeIncomingRequest(token),
      { identity: issuer, clock: fixedClock(now), revocation: neverRevoked },
    );
    expect(authorized).toBe(false);
  });
});
