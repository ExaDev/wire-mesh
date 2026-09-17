// Pure, DOM-free core/webrtc signaling logic: building and parsing the manage-commands spec/webrtc.cddl defines (webrtc.offer/answer/ice-candidate, and webrtc.sfu-track-map), plus authorizing an incoming offer against a capability token. Deliberately has no dependency on RTCPeerConnection or any other browser-only API, so both a browser client (web-console, which layers its own RTCPeerConnection wiring on top of these functions) and a Node-hosted SFU service (which never touches RTCPeerConnection at all) share exactly this one implementation of the wire-level protocol, never two independently-drifting copies of it.

import type {
  CapabilityScope,
  IceCandidateInit,
  ManageCommand,
  ManageCommandParams,
  SfuTrackEntry,
  WebrtcAnswer,
  WebrtcIceCandidate,
  WebrtcOffer,
  SfuTrackMap,
} from "../generated/protocol.js";
import {
  verifyCapabilityToken,
  type VerifyCapabilityTokenOptions,
} from "./tokens.js";
import type { IncomingManageRequest } from "./mesh-session.js";

/** The one capability verb gating every core/webrtc message shape: an authority over this node's own signaling as a whole, not three separate resources, mirroring how core/exec's exec:pty gates all of its own inner verbs. webrtc.sfu-track-map is gated by this same verb (see spec/webrtc.cddl's own comment): an SFU able to shape a negotiation can already misreport whose media is on which mid, so a separate capability over the track-map itself would guard nothing a client doesn't already have to trust the SFU for. */
export const WEBRTC_SIGNAL_VERB = "webrtc:signal";

/** No path: there is no filesystem subtree involved in signaling, only the node itself. */
export const WEBRTC_SIGNAL_SCOPE: CapabilityScope = { kind: "node" };

export function isWebrtcOffer(
  params: ManageCommandParams,
): params is WebrtcOffer {
  return (
    typeof params === "object" &&
    "verb" in params &&
    params.verb === "webrtc.offer"
  );
}

export function isWebrtcAnswer(
  params: ManageCommandParams,
): params is WebrtcAnswer {
  return (
    typeof params === "object" &&
    "verb" in params &&
    params.verb === "webrtc.answer"
  );
}

export function isWebrtcIceCandidate(
  params: ManageCommandParams,
): params is WebrtcIceCandidate {
  return (
    typeof params === "object" &&
    "verb" in params &&
    params.verb === "webrtc.ice-candidate"
  );
}

export function isSfuTrackMap(
  params: ManageCommandParams,
): params is SfuTrackMap {
  return (
    typeof params === "object" &&
    "verb" in params &&
    params.verb === "webrtc.sfu-track-map"
  );
}

export function buildOfferCommand(
  negotiationId: number,
  sdp: string,
): ManageCommand {
  return {
    verb: WEBRTC_SIGNAL_VERB,
    params: { verb: "webrtc.offer", "negotiation-id": negotiationId, sdp },
  };
}

export function buildAnswerCommand(
  negotiationId: number,
  sdp: string,
): ManageCommand {
  return {
    verb: WEBRTC_SIGNAL_VERB,
    params: { verb: "webrtc.answer", "negotiation-id": negotiationId, sdp },
  };
}

export function buildIceCandidateCommand(
  negotiationId: number,
  candidate?: Readonly<IceCandidateInit>,
): ManageCommand {
  return {
    verb: WEBRTC_SIGNAL_VERB,
    params: {
      verb: "webrtc.ice-candidate",
      "negotiation-id": negotiationId,
      ...(candidate !== undefined ? { candidate } : {}),
    },
  };
}

/** Builds the manage-command an SFU sends to report which room member each SDP mid on a negotiation belongs to: sent once a negotiation completes (the initial track set) and again, as a full resend rather than an incremental diff, on every membership change. An empty tracks array is itself a valid, meaningful message (the call is now empty), not a degenerate case. */
export function buildSfuTrackMapCommand(
  negotiationId: number,
  tracks: readonly SfuTrackEntry[],
): ManageCommand {
  return {
    verb: WEBRTC_SIGNAL_VERB,
    params: {
      verb: "webrtc.sfu-track-map",
      "negotiation-id": negotiationId,
      tracks: [...tracks],
    },
  };
}

/** The subset of RTCIceCandidate's own fields this module actually reads: a real RTCIceCandidate satisfies this structurally, and so does a plain test object or a server-side candidate description, with no cast needed either way. */
export type MinimalRtcIceCandidate = Readonly<{
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}>;

export function wireIceCandidateFromRtc(
  candidate: MinimalRtcIceCandidate,
): IceCandidateInit {
  return {
    candidate: candidate.candidate,
    ...(candidate.sdpMid !== null ? { "sdp-mid": candidate.sdpMid } : {}),
    ...(candidate.sdpMLineIndex !== null
      ? { "sdp-m-line-index": candidate.sdpMLineIndex }
      : {}),
    ...(candidate.usernameFragment !== null
      ? { "username-fragment": candidate.usernameFragment }
      : {}),
  };
}

/** The subset of RTCIceCandidateInit's own shape this module produces: structurally identical to the DOM lib's own type (candidate, sdpMid, sdpMLineIndex, usernameFragment, each optional), so a caller in an environment with the DOM lib available (web-console) can pass this straight to RTCPeerConnection.addIceCandidate() with no cast, while core itself stays free of any DOM lib dependency. */
export interface WireRtcIceCandidateInit {
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}

export function rtcIceCandidateInitFromWire(
  wire: Readonly<IceCandidateInit>,
): WireRtcIceCandidateInit {
  return {
    candidate: wire.candidate,
    ...(wire["sdp-mid"] !== undefined ? { sdpMid: wire["sdp-mid"] } : {}),
    ...(wire["sdp-m-line-index"] !== undefined
      ? { sdpMLineIndex: wire["sdp-m-line-index"] }
      : {}),
    ...(wire["username-fragment"] !== undefined
      ? { usernameFragment: wire["username-fragment"] }
      : {}),
  };
}

/** A fresh, independent, monotonically increasing negotiation-id source starting at 0, extracted as its own pure function so id allocation is testable without an RTCPeerConnection or any transport. */
export function createNegotiationIdAllocator(): () => number {
  let next = 0;
  return (): number => {
    const id = next;
    next += 1;
    return id;
  };
}

/** True when an incoming offer's own token authorizes webrtc:signal against this node's scope: verifyCapabilityToken checks the token's own internal validity and delegation chain; the capability/scope match against what is actually being invoked here is this caller's own responsibility, same as any other domain's request handler. expectedBearer is deliberately not checked: neither a browser client's MeshSession nor an SFU's own connection handling exposes a way to learn a peer's device-id independently of the token itself, unlike a scope with a path that constrains a specific resource. */
export async function authorizeIncomingOffer(
  incoming: Readonly<IncomingManageRequest>,
  options: Readonly<VerifyCapabilityTokenOptions>,
): Promise<boolean> {
  if (incoming.token === undefined) {
    return false;
  }
  const verdict = await verifyCapabilityToken(incoming.token, options);
  if (!verdict.ok) {
    return false;
  }
  return (
    verdict.claims.capability === WEBRTC_SIGNAL_VERB &&
    verdict.claims.scope.kind === WEBRTC_SIGNAL_SCOPE.kind
  );
}
