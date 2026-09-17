// Exercises sdp-bridge.ts against a realistic Chrome-shaped offer SDP (the exact structure a real RTCPeerConnection.createOffer() with one audio and one video track, plus a recvonly video m-line for a second participant's track, actually produces: bundled, ICE-per-media, opus/VP8/VP9 payloads, ssrc/cname, rtcp-fb). No mediasoup dependency: this module never imports it.

import { describe, expect, it } from "vitest";
import { parse as parseSdp } from "sdp-transform";
import {
  buildAnswer,
  intersectWithRouterCapabilities,
  parseOffer,
  type BridgeRtpParameters,
} from "../src/adapters/sdp-bridge.js";
import { CHROME_SHAPED_OFFER } from "./fixtures/chrome-offer.js";

const ROUTER_CODECS = [
  { mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  { mimeType: "video/VP8", clockRate: 90000 },
];

describe("parseOffer", () => {
  it("extracts session-wide ICE ufrag/pwd/fingerprint from the first m-line", () => {
    const parsed = parseOffer(CHROME_SHAPED_OFFER);
    expect(parsed.iceDtls).toEqual({
      iceUfrag: "aaaa",
      icePwd: "bbbbbbbbbbbbbbbbbbbbbbbb",
      fingerprint: {
        type: "sha-256",
        hash: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
      },
    });
  });

  it("classifies every m-line by kind and direction, in offer order", () => {
    const parsed = parseOffer(CHROME_SHAPED_OFFER);
    expect(
      parsed.sections.map((section) => [section.mid, section.kind]),
    ).toEqual([
      ["0", "audio"],
      ["1", "video"],
      ["2", "video"],
      ["3", "other"],
    ]);
    expect(parsed.sections.map((section) => section.canReceive)).toEqual([
      true, // audio sendrecv
      true, // video sendrecv
      true, // video recvonly
      false, // application m-line is never receivable
    ]);
  });

  it("builds send rtpParameters only for sendrecv/sendonly m-lines, not the recvonly video slot or the application m-line", () => {
    const parsed = parseOffer(CHROME_SHAPED_OFFER);
    expect(parsed.sections[0]?.send).toBeDefined();
    expect(parsed.sections[1]?.send).toBeDefined();
    expect(parsed.sections[2]?.send).toBeUndefined();
    expect(parsed.sections[3]?.send).toBeUndefined();
  });

  it("parses the audio m-line's own codec, fmtp, rtcp-fb, and ssrc/cname", () => {
    const parsed = parseOffer(CHROME_SHAPED_OFFER);
    const audio = parsed.sections[0]?.send;
    expect(audio).toEqual({
      mid: "0",
      codecs: [
        {
          mimeType: "audio/opus",
          payloadType: 111,
          clockRate: 48000,
          channels: 2,
          parameters: { minptime: 10, useinbandfec: 1 },
          rtcpFeedback: [{ type: "transport-cc" }],
        },
      ],
      encodings: [{ ssrc: 1001 }],
      rtcp: { cname: "stream1" },
    } satisfies BridgeRtpParameters);
  });

  it("parses the video m-line's own RTX pairing via ssrc-group:FID", () => {
    const parsed = parseOffer(CHROME_SHAPED_OFFER);
    const video = parsed.sections[1]?.send;
    expect(video?.encodings).toEqual([{ ssrc: 2001, rtx: { ssrc: 2002 } }]);
    expect(video?.codecs.map((codec) => codec.mimeType)).toEqual([
      "video/VP8",
      "video/rtx",
    ]);
  });
});

describe("intersectWithRouterCapabilities", () => {
  it("narrows to the first router-supported codec when one matches", () => {
    const parsed = parseOffer(CHROME_SHAPED_OFFER);
    const audio = parsed.sections[0]?.send;
    if (audio === undefined) {
      throw new Error("expected audio send parameters");
    }
    const narrowed = intersectWithRouterCapabilities(audio, ROUTER_CODECS);
    expect(narrowed?.codecs).toEqual([
      expect.objectContaining({ mimeType: "audio/opus", payloadType: 111 }),
    ]);
  });

  it("returns undefined when no offered codec is supported by the router", () => {
    const parsed = parseOffer(CHROME_SHAPED_OFFER);
    const audio = parsed.sections[0]?.send;
    if (audio === undefined) {
      throw new Error("expected audio send parameters");
    }
    const narrowed = intersectWithRouterCapabilities(audio, [
      { mimeType: "audio/G722", clockRate: 8000 },
    ]);
    expect(narrowed).toBeUndefined();
  });
});

describe("buildAnswer", () => {
  const baseOptions = {
    iceUfrag: "cccc",
    icePwd: "dddddddddddddddddddddd",
    fingerprint: { type: "sha-256", hash: "11:22:33" },
    candidates: [
      {
        foundation: "1",
        priority: 2130706431,
        ip: "203.0.113.9",
        port: 40000,
        protocol: "udp" as const,
        type: "host",
      },
    ],
    dtlsSetup: "active" as const,
  };

  it("produces a well-formed SDP that sdp-transform can parse back, preserving m-line count and order", () => {
    const answer = buildAnswer({
      ...baseOptions,
      sections: [
        { mid: "0", kind: "audio", direction: "inactive" },
        { mid: "1", kind: "video", direction: "inactive" },
        { mid: "2", kind: "video", direction: "inactive" },
        { mid: "3", kind: "other", direction: "inactive" },
      ],
    });
    const parsed = parseSdp(answer);
    // sdp-transform parses a purely numeric a=mid back as a JS number, not a string, on ANY SDP it parses (including this test's own re-parse of the answer this module wrote); see sdp-bridge.ts's own midOf() for the same real, source-verified quirk on the offer side.
    expect(
      parsed.media.map((media) => [String(media.mid), media.type]),
    ).toEqual([
      ["0", "audio"],
      ["1", "video"],
      ["2", "video"],
      ["3", "application"],
    ]);
  });

  it("rejects the application m-line with port 0 and no codecs", () => {
    const answer = buildAnswer({
      ...baseOptions,
      sections: [{ mid: "3", kind: "other", direction: "inactive" }],
    });
    const parsed = parseSdp(answer);
    expect(parsed.media[0]?.port).toBe(0);
  });

  it("answers a filled recvonly m-line as sendonly, carrying the consumer's own codec", () => {
    const rtpParameters: BridgeRtpParameters = {
      mid: "2",
      codecs: [{ mimeType: "video/VP8", payloadType: 96, clockRate: 90000 }],
      encodings: [{ ssrc: 5001 }],
      rtcp: { cname: "sfu" },
    };
    const answer = buildAnswer({
      ...baseOptions,
      sections: [
        {
          mid: "2",
          kind: "video",
          direction: "sendonly",
          rtpParameters,
        },
      ],
    });
    const parsed = parseSdp(answer);
    const media = parsed.media[0];
    expect(media?.direction).toBe("sendonly");
    expect(media?.rtp).toEqual([{ payload: 96, codec: "VP8", rate: 90000 }]);
  });

  it("carries the given ICE ufrag/pwd/fingerprint/candidates onto the first (bundled) m-line", () => {
    const answer = buildAnswer({
      ...baseOptions,
      sections: [{ mid: "0", kind: "audio", direction: "inactive" }],
    });
    const parsed = parseSdp(answer);
    const media = parsed.media[0];
    expect(media?.iceUfrag).toBe("cccc");
    expect(media?.icePwd).toBe("dddddddddddddddddddddd");
    expect(media?.fingerprint).toEqual({ type: "sha-256", hash: "11:22:33" });
    expect(media?.candidates?.[0]).toMatchObject({
      ip: "203.0.113.9",
      port: 40000,
      transport: "udp",
    });
    expect(media?.setup).toBe("active");
  });
});
