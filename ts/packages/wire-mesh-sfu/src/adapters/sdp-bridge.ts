// Bridges plain WebRTC SDP offer/answer (what a browser RTCPeerConnection, unmodified, actually sends and expects) against mediasoup's own transport/router state, which is expressed as structured RtpParameters/IceParameters/DtlsParameters rather than SDP text. mediasoup deliberately does not do this itself (its own FAQ: "mediasoup does not process or generate SDP... you can build your own SDP handling on top using an npm module such as sdp-transform"); this module is that layer, kept as a standalone adapter with no mediasoup import of its own so it takes and returns only plain, already-portable data shapes (mediasoup's own Rtp/Ice/Dtls parameter types are structurally compatible with what this module expects, needing no cast at the call site in mediasoup-media-backend.ts).
//
// Scope: intersects the offer's own codecs against the router's own RouterRtpCapabilities to choose exactly one payload type per m-line (no simulcast, no codec preference beyond "first mutually supported match"), and treats a non-audio/video m-line (e.g. an application/SCTP m-line from a data channel bundled on the same connection) as rejected in the answer (port 0), never produced or consumed. Both are explicit, documented scope boundaries, not silent gaps: see this package's README for what a fuller implementation would add.

import {
  parse as parseSdp,
  parseParams as parseFmtpConfig,
  write as writeSdp,
} from "sdp-transform";
import type { SessionDescription } from "sdp-transform";

/** sdp-transform's own MediaDescription type omits type/port/protocol/payloads (they only appear on the intersected element type of SessionDescription's own media array); this is that full per-m-line shape, used everywhere this module reads an m-line. */
type Media = SessionDescription["media"][number];

export type MediaKind = "audio" | "video";

export interface ParsedIceDtls {
  iceUfrag: string;
  icePwd: string;
  fingerprint: { type: string; hash: string };
}

/** The subset of mediasoup's own RtpCodecParameters this bridge produces/consumes: structurally compatible with mediasoup's real type, so a caller can pass this straight to router.createWebRtcTransport()'s own produce()/consume() calls with no cast. */
export interface BridgeRtpCodecParameters {
  mimeType: string;
  payloadType: number;
  clockRate: number;
  channels?: number;
  parameters?: Record<string, string | number>;
  rtcpFeedback?: { type: string; parameter?: string }[];
}

export interface BridgeRtpParameters {
  mid: string;
  codecs: BridgeRtpCodecParameters[];
  headerExtensions?: { uri: string; id: number }[];
  encodings?: { ssrc: number; rtx?: { ssrc: number } }[];
  rtcp?: { cname?: string };
}

/** One m-line from a parsed offer: `send` is present when the client proposes sending media on it (sendonly/sendrecv, ready to be produced), `canReceive` is true when the client proposes receiving media on it (recvonly/sendrecv, a slot this backend may consume another participant's track into). Neither being true (an inactive or non-media m-line) still needs its own slot preserved in the answer's own m-line ordering, which is why every m-line gets an entry here, not just the usable ones. */
export interface ParsedOfferSection {
  mid: string;
  kind: MediaKind | "other";
  canReceive: boolean;
  send?: BridgeRtpParameters;
}

export interface ParsedOffer {
  iceDtls: ParsedIceDtls;
  sections: ParsedOfferSection[];
}

function iceDtlsFor(
  session: Readonly<SessionDescription>,
  media: Readonly<Media>,
): ParsedIceDtls {
  const iceUfrag = media.iceUfrag ?? session.iceUfrag;
  const icePwd = media.icePwd ?? session.icePwd;
  const fingerprint = media.fingerprint ?? session.fingerprint;
  if (
    iceUfrag === undefined ||
    icePwd === undefined ||
    fingerprint === undefined
  ) {
    throw new Error(
      `m-line mid=${midOf(media) ?? "?"} carries no ICE ufrag/pwd or DTLS fingerprint, at session or media level`,
    );
  }
  return { iceUfrag, icePwd, fingerprint };
}

function kindOf(media: Readonly<Media>): MediaKind | "other" {
  return media.type === "audio" || media.type === "video"
    ? media.type
    : "other";
}

/** sdp-transform's own grammar has no explicit string type for a=mid, so a purely numeric mid value (e.g. "a=mid:0", by far the most common case: Chrome, Firefox, and Safari all number their own mids from 0) parses back as the JS number 0, not the string "0", despite the declared `mid?: string` type, confirmed directly against sdp-transform's own grammar.js (the `mid` rule carries no `type` marker, so it falls through the library's generic numify-if-numeric-looking parsing) and against this bridge's own test suite. Every mid this module reads goes through this one coercion point, narrowing to number|string explicitly (never a bare String() on the declared-but-inaccurate type) so the eslint no-base-to-string/no-unnecessary-type-conversion rules stay meaningful here rather than needing a disable. */
function midOf(media: Readonly<Media>): string | undefined {
  const mid: unknown = media.mid;
  if (typeof mid === "number") {
    return String(mid);
  }
  return typeof mid === "string" ? mid : undefined;
}

/** Builds a single-encoding (non-simulcast) BridgeRtpParameters from one m-line's own rtp/fmtp/ext/ssrc attributes: every payload the offer proposes for this m-line, not narrowed to any router's own capabilities yet (see intersectWithRouterCapabilities, which narrows this down to exactly one mutually supported codec before it's ever handed to mediasoup). */
function rtpParametersFromMedia(media: Readonly<Media>): BridgeRtpParameters {
  const mid = midOf(media);
  if (mid === undefined) {
    throw new Error("m-line carries no a=mid");
  }
  const fmtpByPayload = new Map(
    media.fmtp.map((entry) => [entry.payload, entry.config]),
  );
  const rtcpFbByPayload = new Map<
    number,
    { type: string; parameter?: string }[]
  >();
  for (const entry of media.rtcpFb ?? []) {
    const existing = rtcpFbByPayload.get(entry.payload) ?? [];
    existing.push({
      type: entry.type,
      ...(entry.subtype !== undefined ? { parameter: entry.subtype } : {}),
    });
    rtcpFbByPayload.set(entry.payload, existing);
  }
  const codecs: BridgeRtpCodecParameters[] = media.rtp.map((rtp) => {
    const config = fmtpByPayload.get(rtp.payload);
    const rtcpFeedback = rtcpFbByPayload.get(rtp.payload);
    return {
      mimeType: `${media.type}/${rtp.codec}`,
      payloadType: rtp.payload,
      clockRate: rtp.rate ?? 0,
      ...(rtp.encoding !== undefined ? { channels: rtp.encoding } : {}),
      ...(config !== undefined ? { parameters: parseFmtpConfig(config) } : {}),
      ...(rtcpFeedback !== undefined ? { rtcpFeedback } : {}),
    };
  });
  const headerExtensions = (media.ext ?? []).map((ext) => ({
    uri: ext.uri,
    id: ext.value,
  }));
  const cnameEntry = (media.ssrcs ?? []).find(
    (entry) => entry.attribute === "cname",
  );
  const mediaSsrc = (media.ssrcs ?? []).find(
    (entry) => entry.attribute === "cname",
  )?.id;
  const rtxSsrc = (media.ssrcGroups ?? [])
    .filter((group) => group.semantics === "FID")
    .map((group) => group.ssrcs.split(" ").map(Number))
    .find((pair) => pair[0] === mediaSsrc)?.[1];
  return {
    mid,
    codecs,
    ...(headerExtensions.length > 0 ? { headerExtensions } : {}),
    ...(mediaSsrc !== undefined
      ? {
          encodings: [
            {
              ssrc: Number(mediaSsrc),
              ...(rtxSsrc !== undefined ? { rtx: { ssrc: rtxSsrc } } : {}),
            },
          ],
        }
      : {}),
    ...(cnameEntry?.value !== undefined
      ? { rtcp: { cname: cnameEntry.value } }
      : {}),
  };
}

const RECEIVING_DIRECTIONS = new Set(["sendrecv", "sendonly"]);
const CAN_RECEIVE_DIRECTIONS = new Set(["sendrecv", "recvonly"]);

export function parseOffer(offerSdp: string): ParsedOffer {
  const session = parseSdp(offerSdp);
  const sections: ParsedOfferSection[] = session.media.map((media) => {
    const kind = kindOf(media);
    const direction = media.direction ?? "sendrecv";
    const mid = midOf(media) ?? "";
    if (kind === "other") {
      return { mid, kind, canReceive: false };
    }
    return {
      mid,
      kind,
      canReceive: CAN_RECEIVE_DIRECTIONS.has(direction),
      ...(RECEIVING_DIRECTIONS.has(direction)
        ? { send: rtpParametersFromMedia(media) }
        : {}),
    };
  });
  // iceDtls is identical across every real m-line in a bundled (a=group:BUNDLE) offer: every browser offer this backend supports is bundled, so the first media section carrying it is authoritative for the whole connection.
  const firstMedia = session.media[0];
  if (firstMedia === undefined) {
    throw new Error("offer carries no m-lines");
  }
  return { iceDtls: iceDtlsFor(session, firstMedia), sections };
}

/** Narrows a send m-line's own proposed codec list down to exactly one mutually supported codec (the first match, by mimeType/clockRate/channels), the payload type this bridge will actually tell mediasoup to produce. Returns undefined if none of the offer's own codecs for this m-line are supported by the router at all: a real possibility (e.g. a codec the router's own mediaCodecs never configured), reported to the caller rather than thrown, since one unsupported m-line shouldn't fail the whole offer. */
export function intersectWithRouterCapabilities(
  offered: Readonly<BridgeRtpParameters>,
  routerCodecs: readonly {
    mimeType: string;
    clockRate: number;
    channels?: number;
  }[],
): BridgeRtpParameters | undefined {
  const matched = offered.codecs.find((codec) =>
    routerCodecs.some(
      (routerCodec) =>
        routerCodec.mimeType.toLowerCase() === codec.mimeType.toLowerCase() &&
        routerCodec.clockRate === codec.clockRate &&
        (routerCodec.channels ?? 1) === (codec.channels ?? 1),
    ),
  );
  if (matched === undefined) {
    return undefined;
  }
  return { ...offered, codecs: [matched] };
}

export interface AnswerSection {
  mid: string;
  kind: MediaKind | "other";
  /** "inactive" for a send-capable m-line this backend is only consuming from (produced, never answered back with media of our own on the same mid), for a recv-capable m-line this backend has nothing to fill yet, or for a rejected non-media m-line. "sendonly" for a recv-capable m-line this backend filled with another participant's track. */
  direction: "sendonly" | "inactive";
  /** The codec/encoding this backend answers with: required when direction is "sendonly" (the Consumer's own rtpParameters), omitted for "inactive"/rejected sections. */
  rtpParameters?: BridgeRtpParameters;
}

export interface BuildAnswerOptions {
  sections: readonly AnswerSection[];
  iceUfrag: string;
  icePwd: string;
  fingerprint: { type: string; hash: string };
  candidates: readonly {
    foundation: string;
    priority: number;
    ip: string;
    port: number;
    protocol: "udp" | "tcp";
    type: string;
  }[];
  /** This backend's own DTLS role in the handshake: mediasoup's own WebRtcTransport.dtlsParameters.role is "auto" until connect() is called with an explicit role, and the answer's own a=setup value is what actually tells the browser which role to take, so this is supplied by the caller (mediasoup-media-backend.ts), not read back off the transport. */
  dtlsSetup: "active" | "passive";
}

const SDP_UNICAST_ADDRESS = "0.0.0.0";
const SDP_PORT_WHEN_BUNDLED = 9; // RFC 8843: every bundled m-line after the first uses the discard port; ICE/DTLS/media all flow over the first m-line's own candidates.
const SDP_PORT_REJECTED = 0;

/** Builds a complete SDP answer for a parsed offer's own m-line sequence: sections must be given in exactly the same order as the offer's own parseOffer().sections, one per m-line, so RFC 8843 bundling and m-line-position matching hold. Every section becomes a real m-line: "other" (non-audio/video) sections are rejected (port 0), matching how this bridge treats them in parseOffer. */
export function buildAnswer(options: Readonly<BuildAnswerOptions>): string {
  const bundleMids = options.sections
    .filter((section) => section.kind !== "other")
    .map((section) => section.mid);
  const session: SessionDescription = {
    version: 0,
    origin: {
      username: "-",
      sessionId: Date.now(),
      sessionVersion: 1,
      netType: "IN",
      ipVer: 4,
      address: SDP_UNICAST_ADDRESS,
    },
    name: "-",
    timing: { start: 0, stop: 0 },
    groups: [{ type: "BUNDLE", mids: bundleMids.join(" ") }],
    msidSemantic: { semantic: "WMS", token: "*" },
    media: options.sections.map((section, index) =>
      buildAnswerMedia(section, index, options),
    ),
  };
  return writeSdp(session);
}

function buildAnswerMedia(
  section: Readonly<AnswerSection>,
  index: number,
  options: Readonly<BuildAnswerOptions>,
): SessionDescription["media"][number] {
  if (section.kind === "other") {
    return {
      type: "application",
      port: SDP_PORT_REJECTED,
      protocol: "UDP/DTLS/SCTP",
      payloads: "webrtc-datachannel",
      mid: section.mid,
      rtp: [],
      fmtp: [],
    };
  }
  const rtpParameters = section.rtpParameters;
  const payloads = rtpParameters?.codecs.map((codec) => codec.payloadType);
  return {
    type: section.kind,
    port:
      index === 0
        ? (options.candidates[0]?.port ?? SDP_PORT_REJECTED)
        : SDP_PORT_WHEN_BUNDLED,
    protocol: "UDP/TLS/RTP/SAVPF",
    payloads: payloads?.join(" ") ?? "",
    mid: section.mid,
    direction: section.direction,
    rtcpMux: "rtcp-mux",
    iceUfrag: options.iceUfrag,
    icePwd: options.icePwd,
    fingerprint: options.fingerprint,
    setup: options.dtlsSetup,
    candidates: options.candidates.map((candidate, candidateIndex) => ({
      foundation: candidate.foundation,
      component: 1,
      transport: candidate.protocol,
      priority: candidate.priority,
      ip: candidate.ip,
      port: candidate.port,
      type: candidate.type,
      generation: candidateIndex,
    })),
    endOfCandidates: "end-of-candidates",
    rtp: (rtpParameters?.codecs ?? []).map((codec) => ({
      payload: codec.payloadType,
      codec: codec.mimeType.split("/")[1] ?? codec.mimeType,
      rate: codec.clockRate,
      ...(codec.channels !== undefined ? { encoding: codec.channels } : {}),
    })),
    fmtp: (rtpParameters?.codecs ?? [])
      .filter((codec) => codec.parameters !== undefined)
      .map((codec) => ({
        payload: codec.payloadType,
        config: Object.entries(codec.parameters ?? {})
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(";"),
      })),
  };
}
