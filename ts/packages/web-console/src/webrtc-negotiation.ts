// Drives a real RTCPeerConnection through the core/webrtc signaling exchange over an existing MeshSession's sendManageRequest/incomingManageRequests plumbing -- the one place in this package that both consumes the browser's WebRTC API and speaks the wire protocol, so it lives beside the adapters rather than in @exadev/wire-mesh-core's own mesh-session domain module (protocol-generic) or main.ts (DOM-only). One negotiator is constructed per session and, from construction, both offers new negotiations and answers incoming ones on that same session. The protocol itself carries no target-device field (a webrtc-offer's scope is "this node's own signaling", not a routed resource) -- addressing a specific peer when this session's own Connection is to a relay hub rather than to the peer directly is a MeshSession.sendManageRequest concern (its own targetDevice parameter), not something this module encodes on the wire.

import type { Connection } from "@exadev/wire-mesh-core/ports/transport";
import type { IdentityPort } from "@exadev/wire-mesh-core/ports/identity";
import type { Clock } from "@exadev/wire-mesh-core/ports/clock";
import {
  verifyCapabilityToken,
  type RevocationCheck,
  type VerifyCapabilityTokenOptions,
} from "@exadev/wire-mesh-core/domain/tokens";
import type {
  CapabilityScope,
  DeviceId,
  IceCandidateInit,
  ManageCommand,
  ManageCommandParams,
  WebrtcAnswer,
  WebrtcIceCandidate,
  WebrtcOffer,
} from "@exadev/wire-mesh-core/generated/protocol";
import type {
  IncomingManageRequest,
  MeshSession,
} from "@exadev/wire-mesh-core/domain/mesh-session";
import { wrapRtcDataChannel } from "./adapters/webrtc-transport.js";

/** The one capability verb gating every core/webrtc message shape -- an authority over this node's own signaling as a whole, not three separate resources, mirroring how core/exec's exec:pty gates all of its own inner verbs. */
export const WEBRTC_SIGNAL_VERB = "webrtc:signal";

/** No path: there is no filesystem subtree involved in signaling, only the node itself. */
export const WEBRTC_SIGNAL_SCOPE: CapabilityScope = { kind: "node" };

const DATA_CHANNEL_LABEL = "wire-mesh";

/**
 * web-console has no revocation-gossip ingestion yet -- there is nowhere for a revocation-announce frame to land and be recorded. This is an explicit, deliberate limitation of this console specifically (not core, not the protocol): every otherwise-valid token is treated as unrevoked. A future console revision that ingests revocation-announce frames into a real store should replace this, not extend it.
 */
const noRevocationCheck: RevocationCheck = {
  isRevoked: async () => Promise.resolve(false),
};

export interface WebrtcNegotiatorOptions {
  identity: IdentityPort;
  clock: Clock;
  /** Called once for each incoming, authorized offer, with the resulting Connection once its data channel opens. */
  onIncomingConnection: (connection: Readonly<Connection>) => void;
}

export interface WebrtcNegotiator {
  /** Offers a new WebRTC data channel. With no targetDevice, the offer is sent directly over whatever this session's own Connection is (a direct peer-to-peer session, or a bespoke test relay that forwards everything verbatim). With targetDevice, the offer -- and every subsequent message this negotiation sends (answer, ice candidates) -- is routed to that specific peer via a relay-connect pairing, since a real relay hub deliberately drops manage-request/manage-response frames sent to it directly. Resolves once the channel opens, with it wrapped as a Connection; rejects if the peer's own manage-response to the offer itself reports an error (e.g. unauthorized). */
  initiate: (targetDevice?: DeviceId) => Promise<Connection>;
}

function isWebrtcOffer(params: ManageCommandParams): params is WebrtcOffer {
  return (
    typeof params === "object" &&
    "verb" in params &&
    params.verb === "webrtc.offer"
  );
}

function isWebrtcAnswer(params: ManageCommandParams): params is WebrtcAnswer {
  return (
    typeof params === "object" &&
    "verb" in params &&
    params.verb === "webrtc.answer"
  );
}

function isWebrtcIceCandidate(
  params: ManageCommandParams,
): params is WebrtcIceCandidate {
  return (
    typeof params === "object" &&
    "verb" in params &&
    params.verb === "webrtc.ice-candidate"
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

/** The subset of RTCIceCandidate's own fields this module actually reads -- a real RTCIceCandidate satisfies this structurally, and so does a plain test object, with no cast needed either way. */
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

export function rtcIceCandidateInitFromWire(
  wire: Readonly<IceCandidateInit>,
): RTCIceCandidateInit {
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

/** A fresh, independent, monotonically increasing negotiation-id source starting at 0 -- extracted as its own pure function so id allocation is testable without an RTCPeerConnection. */
export function createNegotiationIdAllocator(): () => number {
  let next = 0;
  return (): number => {
    const id = next;
    next += 1;
    return id;
  };
}

/** True when an incoming offer's own token authorizes webrtc:signal against this node's scope -- verifyCapabilityToken checks the token's own internal validity and delegation chain; the capability/scope match against what is actually being invoked here is this negotiator's own responsibility, same as any other domain's request handler. expectedBearer is deliberately not checked: MeshSession exposes no way for this negotiator to learn its peer's device-id independently of the token itself, unlike a scope with a path that constrains a specific resource. */
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

// The caller must set channel.binaryType = "arraybuffer" itself before calling this, exactly like wrapRtcDataChannel's own contract -- this function never mutates the channel it is handed.
function wireOpenChannel(
  channel: Readonly<RTCDataChannel>,
  onOpen: (connection: Readonly<Connection>) => void,
): void {
  channel.addEventListener(
    "open",
    () => {
      onOpen(wrapRtcDataChannel(channel));
    },
    { once: true },
  );
}

export function createWebrtcNegotiator(
  session: Readonly<MeshSession>,
  options: Readonly<WebrtcNegotiatorOptions>,
): WebrtcNegotiator {
  const verifyOptions: VerifyCapabilityTokenOptions = {
    identity: options.identity,
    clock: options.clock,
    revocation: noRevocationCheck,
  };
  // Keyed by negotiation-id, shared by both roles this negotiator plays: an outgoing initiate() call and an incoming accepted offer both register here, so a later ice-candidate message (which carries no role information of its own) routes to the right peer connection regardless of who initiated.
  const peerConnections = new Map<number, RTCPeerConnection>();
  // The peer device each negotiation was addressed to via relay, if any -- undefined for a direct (non-relayed) negotiation. Recorded once, when the negotiation starts (initiate() for the offering side, the offer's own incoming.fromDevice for the answering side), and reused for every later manage-request this same negotiation sends (the answer, every ice candidate) so they all route the same way as the negotiation's first message.
  const negotiationTargets = new Map<number, DeviceId | undefined>();
  const allocateNegotiationId = createNegotiationIdAllocator();

  async function sendIceCandidate(
    negotiationId: number,
    candidate: MinimalRtcIceCandidate | null,
  ): Promise<void> {
    const command = buildIceCandidateCommand(
      negotiationId,
      candidate !== null ? wireIceCandidateFromRtc(candidate) : undefined,
    );
    await session.sendManageRequest(
      command,
      WEBRTC_SIGNAL_SCOPE,
      negotiationTargets.get(negotiationId),
    );
  }

  async function handleIncomingOffer(
    incoming: Readonly<IncomingManageRequest>,
    offer: Readonly<WebrtcOffer>,
  ): Promise<void> {
    const authorized = await authorizeIncomingOffer(incoming, verifyOptions);
    if (!authorized) {
      await incoming.respond({ result: "error", code: "unauthorized" });
      return;
    }
    const negotiationId = offer["negotiation-id"];
    negotiationTargets.set(negotiationId, incoming.fromDevice);
    // No ICE servers configured -- host candidates alone are enough for the same-LAN scenario this feature exists for; a caller needing cross-network NAT traversal would thread STUN/TURN servers in here, deliberately not built since nothing in this plan calls for it.
    const pc = new RTCPeerConnection();
    peerConnections.set(negotiationId, pc);
    pc.addEventListener("icecandidate", (event) => {
      void sendIceCandidate(negotiationId, event.candidate);
    });
    pc.addEventListener("datachannel", (event) => {
      event.channel.binaryType = "arraybuffer";
      wireOpenChannel(event.channel, options.onIncomingConnection);
    });
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await incoming.respond({ result: "ok" });
    await session.sendManageRequest(
      buildAnswerCommand(negotiationId, answer.sdp ?? ""),
      WEBRTC_SIGNAL_SCOPE,
      incoming.fromDevice,
    );
  }

  async function handleIncomingAnswer(
    incoming: Readonly<IncomingManageRequest>,
    answer: Readonly<WebrtcAnswer>,
  ): Promise<void> {
    const pc = peerConnections.get(answer["negotiation-id"]);
    if (pc !== undefined) {
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    }
    await incoming.respond({ result: "ok" });
  }

  async function handleIncomingIceCandidate(
    incoming: Readonly<IncomingManageRequest>,
    message: Readonly<WebrtcIceCandidate>,
  ): Promise<void> {
    const pc = peerConnections.get(message["negotiation-id"]);
    if (pc !== undefined) {
      await pc.addIceCandidate(
        message.candidate !== undefined
          ? rtcIceCandidateInitFromWire(message.candidate)
          : null,
      );
    }
    await incoming.respond({ result: "ok" });
  }

  async function consumeIncoming(): Promise<void> {
    for await (const incoming of session.incomingManageRequests) {
      if (incoming.command.verb !== WEBRTC_SIGNAL_VERB) {
        // Not this negotiator's business. Today it is the session's only incomingManageRequests consumer (no other module in this package reads that stream), so an unrelated verb is left unanswered rather than misrouted -- a shared request router across domains is future work for whenever a second consumer actually exists.
        continue;
      }
      const params = incoming.command.params;
      if (isWebrtcOffer(params)) {
        await handleIncomingOffer(incoming, params);
      } else if (isWebrtcAnswer(params)) {
        await handleIncomingAnswer(incoming, params);
      } else if (isWebrtcIceCandidate(params)) {
        await handleIncomingIceCandidate(incoming, params);
      }
    }
  }
  void consumeIncoming();

  return {
    async initiate(targetDevice?: DeviceId): Promise<Connection> {
      const negotiationId = allocateNegotiationId();
      negotiationTargets.set(negotiationId, targetDevice);
      // No ICE servers configured -- see the matching comment in handleIncomingOffer.
      const pc = new RTCPeerConnection();
      peerConnections.set(negotiationId, pc);
      pc.addEventListener("icecandidate", (event) => {
        void sendIceCandidate(negotiationId, event.candidate);
      });
      const channel = pc.createDataChannel(DATA_CHANNEL_LABEL);
      channel.binaryType = "arraybuffer";
      const channelOpen = new Promise<Connection>((resolve, reject) => {
        wireOpenChannel(channel, resolve);
        channel.addEventListener(
          "error",
          () => {
            reject(new Error("data channel failed to open"));
          },
          { once: true },
        );
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const outcome = await session.sendManageRequest(
        buildOfferCommand(negotiationId, offer.sdp ?? ""),
        WEBRTC_SIGNAL_SCOPE,
        targetDevice,
      );
      if (outcome.result === "error") {
        peerConnections.delete(negotiationId);
        negotiationTargets.delete(negotiationId);
        pc.close();
        throw new Error(`webrtc offer rejected: ${outcome.code}`);
      }
      return channelOpen;
    },
  };
}
