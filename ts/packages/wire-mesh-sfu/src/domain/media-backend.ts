// The provider-neutral contract between this package's own signaling/session orchestration and whichever media-processing implementation actually forwards RTP: the "backend" axis the design settled in wire-mesh#37 calls out as independent of deployment mode. mediasoup-media-backend.ts is the one real implementation this package ships; nothing in this contract's own shape (parameter or return types) mentions mediasoup, a vendor SDK type, or any other provider-specific primitive, so a from-scratch or differently-licensed backend could satisfy it later with zero changes here or at any call site, matching this workspace's own portable-runtime-boundary principle. Every method takes and returns plain, serialisable data (participant ids as strings, SDP as strings, ICE candidates as the already-portable WireRtcIceCandidateInit shape wire-mesh-core already defined for exactly this purpose) rather than a live object handle, so a remote-process backend reached over a transport could satisfy the identical contract with no signature change either.

import type { SfuTrackEntry } from "wire-mesh-core/generated/protocol";
import type { WireRtcIceCandidateInit } from "wire-mesh-core/domain/webrtc-signaling";

/** One SDP mid this backend is now sending toward a participant's connection (a Producer it accepted from that participant's own offer) or receiving from it (a Consumer forwarding another participant's media). kind is carried alongside mid/direction purely for the caller's own bookkeeping (building sfu-track-map entries needs it); this backend attaches no other meaning to it. */
export interface BackendTrack {
  mid: string;
  kind: SfuTrackEntry["kind"];
}

export interface JoinResult {
  /** The SDP answer to send back as this negotiation's webrtc.answer. */
  answerSdp: string;
  /** Every mid this backend is now receiving media on from the joining participant's own offer (their own outbound audio/video): reported so the session layer can attribute these tracks to the joining participant in every OTHER connected participant's own next sfu-track-map. */
  produced: readonly BackendTrack[];
  /** Every mid on the joining participant's own connection this backend filled with another, already-connected participant's media, alongside which participant it came from: reported so the session layer can build this joining participant's own first sfu-track-map immediately, with no separate round trip. */
  consumed: readonly (BackendTrack & { fromParticipantId: string })[];
}

/** The media-processing half of an SFU: accepts one participant's own WebRTC offer and produces/consumes RTP on their behalf, entirely behind plain SDP: no caller of this port ever constructs or inspects SDP itself; that is this port's own job. Deliberately session-shaped, not connection-shaped: a real implementation owns whatever transport/router state a participant's media needs for as long as they're joined, keyed by the caller-chosen participantId. */
export interface SfuMediaBackend {
  /**
   * Accepts a participant's initial WebRTC offer: produces from every send-capable m-line (this participant's own outbound audio/video) and, for every recv-capable m-line the offer already proposes, consumes one already-connected other participant's matching-kind track into it if one is available. A participant's own recvonly m-line count therefore bounds how many other participants' tracks it can receive without a later renegotiation: see this package's README for why a fixed pre-allocated slot count, not dynamic renegotiation, is this version's own explicit scope boundary.
   */
  join(participantId: string, offerSdp: string): Promise<JoinResult>;
  /**
   * Feeds one trickled ICE candidate from a participant to this backend. A null candidate is the end-of-candidates signal. Most WebRTC-media-server implementations (mediasoup's ICE Lite mode included) never need the remote's own candidates to complete connectivity, since they listen passively on their own already-advertised candidates and let the remote (the ICE-controlling side) perform connectivity checks, so a correct implementation may legitimately treat this as a no-op. It stays part of the contract because a full (non-lite) ICE agent backend genuinely would need it, and the session layer above has no reason to know which kind of agent the current backend runs.
   */
  addIceCandidate(
    participantId: string,
    candidate: WireRtcIceCandidateInit | null,
  ): Promise<void>;
  /** Tears down every resource this backend holds for one participant (their own transport, every Producer and Consumer touching it) and reports which OTHER already-joined participants were consuming this one's tracks, so the session layer knows whose next sfu-track-map changed. */
  leave(participantId: string): Promise<readonly string[]>;
}
