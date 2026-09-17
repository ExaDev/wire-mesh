// Drives a real RTCPeerConnection through the core/webrtc signaling exchange over an existing MeshSession's sendManageRequest/incomingManageRequests plumbing -- the one place in this package that both consumes the browser's WebRTC API and speaks the wire protocol, so it lives beside the adapters rather than in wire-mesh-core's own mesh-session domain module (protocol-generic) or main.ts (DOM-only). One negotiator is constructed per session and, from construction, both offers new negotiations and answers incoming ones on that same session. The protocol itself carries no target-device field (a webrtc-offer's scope is "this node's own signaling", not a routed resource) -- addressing a specific peer when this session's own Connection is to a relay hub rather than to the peer directly is a MeshSession.sendManageRequest concern (its own targetDevice parameter), not something this module encodes on the wire.

import type { Connection } from "wire-mesh-core/ports/transport";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import {
  type RevocationCheck,
  type VerifyCapabilityTokenOptions,
} from "wire-mesh-core/domain/tokens";
import type {
  DeviceId,
  WebrtcAnswer,
  WebrtcIceCandidate,
  WebrtcOffer,
} from "wire-mesh-core/generated/protocol";
import type {
  IncomingManageRequest,
  MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import {
  WEBRTC_SIGNAL_SCOPE,
  WEBRTC_SIGNAL_VERB,
  authorizeIncomingOffer,
  buildAnswerCommand,
  buildIceCandidateCommand,
  buildOfferCommand,
  createNegotiationIdAllocator,
  isWebrtcAnswer,
  isWebrtcIceCandidate,
  isWebrtcOffer,
  rtcIceCandidateInitFromWire,
  wireIceCandidateFromRtc,
  type MinimalRtcIceCandidate,
} from "wire-mesh-core/domain/webrtc-signaling";
import { wrapRtcDataChannel } from "./adapters/webrtc-transport.js";

const DATA_CHANNEL_LABEL = "wire-mesh";

/**
 * web-console has no revocation-gossip ingestion yet -- there is nowhere for a revocation-announce frame to land and be recorded. This is an explicit, deliberate limitation of this console specifically (not core, not the protocol): every otherwise-valid token is treated as unrevoked. A future console revision that ingests revocation-announce frames into a real store should replace this, not extend it. Exported since useRoomMessaging's own createRoomRouter needs the identical limitation for the identical reason -- there is exactly one revocation posture for the whole console, not one per domain.
 */
export const noRevocationCheck: RevocationCheck = {
  entriesFor: async () => Promise.resolve([]),
};

export interface WebrtcNegotiatorOptions {
  identity: IdentityPort;
  clock: Clock;
  /** Called once for each incoming, authorized offer, with the resulting Connection once its data channel opens. */
  onIncomingConnection: (connection: Readonly<Connection>) => void;
  /** Local media tracks added to every peer connection this negotiator creates, offering or answering alike -- core/webrtc's signaling carries raw SDP opaquely, so the identical offer/answer/ICE exchange already used for the data channel carries these with no wire change (see wire-mesh#35). Omit (or pass none) for a data-channel-only negotiator, exactly today's existing behaviour. */
  localTracks?: readonly MediaStreamTrack[];
  /** Fired for every remote track received on any peer connection this negotiator manages, offering or answering alike. */
  onRemoteTrack?: (event: Readonly<RTCTrackEvent>) => void;
}

export interface WebrtcNegotiator {
  /** Offers a new WebRTC data channel. With no targetDevice, the offer is sent directly over whatever this session's own Connection is (a direct peer-to-peer session, or a bespoke test relay that forwards everything verbatim). With targetDevice, the offer -- and every subsequent message this negotiation sends (answer, ice candidates) -- is routed to that specific peer via a relay-connect pairing, since a real relay hub deliberately drops manage-request/manage-response frames sent to it directly. Resolves once the channel opens, with it wrapped as a Connection; rejects if the peer's own manage-response to the offer itself reports an error (e.g. unauthorized). */
  initiate: (targetDevice?: DeviceId) => Promise<Connection>;
}

/** Adds every local track (if any) and wires up the remote-track listener (if given) on a freshly-constructed peer connection -- shared between initiate() and handleIncomingOffer() so both roles carry media identically, matching how they already share the data-channel/ICE-candidate wiring pattern. A no-op call (neither option given) is exactly today's data-channel-only behaviour. */
function wireMediaTracks(
  pc: Readonly<RTCPeerConnection>,
  options: Readonly<WebrtcNegotiatorOptions>,
): void {
  for (const track of options.localTracks ?? []) {
    pc.addTrack(track);
  }
  if (options.onRemoteTrack !== undefined) {
    pc.addEventListener("track", options.onRemoteTrack);
  }
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
    wireMediaTracks(pc, options);
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
      wireMediaTracks(pc, options);
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
