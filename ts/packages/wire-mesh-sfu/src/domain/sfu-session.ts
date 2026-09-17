// Orchestrates one call: every connected participant's own MeshSession, dispatching their core/webrtc manage-requests to a SfuMediaBackend and publishing webrtc.sfu-track-map to every affected participant whenever the roster changes. Knows nothing about mediasoup, SDP, or any transport concretely: every dependency arrives as a port (SfuMediaBackend) or an already-negotiated MeshSession, so this module is the same kind of pure orchestration relay-hub.ts is for the plain relay role, just for the SFU's own facilitator role instead.

import type {
  DeviceId,
  WebrtcIceCandidate,
} from "wire-mesh-core/generated/protocol";
import type {
  IncomingManageRequest,
  MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import type { VerifyCapabilityTokenOptions } from "wire-mesh-core/domain/tokens";
import {
  WEBRTC_SIGNAL_VERB,
  authorizeIncomingOffer,
  buildSfuTrackMapCommand,
  isSfuTrackMap,
  isWebrtcAnswer,
  isWebrtcIceCandidate,
  isWebrtcOffer,
  rtcIceCandidateInitFromWire,
} from "wire-mesh-core/domain/webrtc-signaling";
import type { SfuMediaBackend } from "./media-backend.js";

export interface SfuCall {
  /** Wires up one already-accepted participant's MeshSession: authorizes and answers its own webrtc.offer via the shared media backend, forwards its ice-candidates, and republishes sfu-track-map to every other current participant whose roster this one's join affected. Runs until the session's own incomingManageRequests stream ends (the participant disconnected); call removeParticipant(deviceId) once wireUpConnection's own onSessionEnd fires so this call's own roster stays accurate. Resolves once the participant's own incoming stream ends. */
  addParticipant: (
    deviceId: DeviceId,
    session: Readonly<MeshSession>,
  ) => Promise<void>;
  /** Removes one participant's roster entry and closes its backend resources, republishing sfu-track-map to every other participant the backend reports was affected. Idempotent: a participant already removed (or never added) is a no-op. */
  removeParticipant: (deviceId: DeviceId) => Promise<void>;
  /** The number of participants currently tracked, for tests and diagnostics. */
  readonly participantCount: number;
}

interface ParticipantEntry {
  deviceId: DeviceId;
  session: Readonly<MeshSession>;
  /** deviceId, hex-encoded, purely as this call's own backend participantId: SfuMediaBackend's contract takes plain strings, not DeviceId's raw bytes, since a remote-process backend needs a serialisable key. */
  participantId: string;
  /** This participant's own current negotiation-id, learned from its offer, so a later sfu-track-map to it (or its own answer) can carry the right value. Undefined until its first offer arrives. */
  negotiationId?: number;
}

const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;

function participantIdFor(deviceId: DeviceId): string {
  let id = "";
  for (const byte of deviceId) {
    id += byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0");
  }
  return id;
}

/** Sends this participant's own current sfu-track-map: every mid on its own connection now carrying live media, whether from its own initial join (backend-reported consumed tracks) or a later participant leaving (an empty resend for any mid whose track just ended). negotiationId must already be known (the participant's own offer must have arrived): a participant this call has never negotiated with has no connection-specific mid space to describe. */
async function sendTrackMap(
  entry: Readonly<ParticipantEntry>,
  tracks: readonly {
    mid: string;
    member: DeviceId;
    kind: "audio" | "video";
  }[],
): Promise<void> {
  if (entry.negotiationId === undefined) {
    return;
  }
  const command = buildSfuTrackMapCommand(entry.negotiationId, tracks);
  await entry.session.sendManageRequest(command, { kind: "node" });
}

export function createSfuCall(
  backend: Readonly<SfuMediaBackend>,
  verifyOptions: Readonly<VerifyCapabilityTokenOptions>,
): SfuCall {
  const participants = new Map<string, ParticipantEntry>();
  // Every currently live track this call knows about, per owning participant: rebuilt into a per-recipient tracks[] array (excluding the recipient's own tracks) whenever any recipient's sfu-track-map needs resending. Kept flat (not nested under the consuming participant) since it describes the call's actual media state, not any one participant's own view of it.
  const liveTracks = new Map<
    string,
    { mid: string; member: DeviceId; kind: "audio" | "video" }[]
  >();

  function tracksForRecipient(
    recipientParticipantId: string,
  ): { mid: string; member: DeviceId; kind: "audio" | "video" }[] {
    const tracks: {
      mid: string;
      member: DeviceId;
      kind: "audio" | "video";
    }[] = [];
    for (const [ownerId, ownerTracks] of liveTracks) {
      if (ownerId === recipientParticipantId) {
        continue;
      }
      tracks.push(...ownerTracks);
    }
    return tracks;
  }

  async function republishTo(participantId: string): Promise<void> {
    const entry = participants.get(participantId);
    if (entry === undefined) {
      return;
    }
    await sendTrackMap(entry, tracksForRecipient(participantId));
  }

  async function handleOffer(
    entry: ParticipantEntry,
    incoming: Readonly<IncomingManageRequest>,
    offer: Readonly<{ "negotiation-id": number; sdp: string }>,
  ): Promise<void> {
    const authorized = await authorizeIncomingOffer(incoming, verifyOptions);
    if (!authorized) {
      await incoming.respond({ result: "error", code: "unauthorized" });
      return;
    }
    entry.negotiationId = offer["negotiation-id"];
    const result = await backend.join(entry.participantId, offer.sdp);
    liveTracks.set(
      entry.participantId,
      result.produced.map((track) => ({
        mid: track.mid,
        member: entry.deviceId,
        kind: track.kind,
      })),
    );
    await incoming.respond({ result: "ok" });
    await entry.session.sendManageRequest(
      {
        verb: WEBRTC_SIGNAL_VERB,
        params: {
          verb: "webrtc.answer",
          "negotiation-id": entry.negotiationId,
          sdp: result.answerSdp,
        },
      },
      { kind: "node" },
    );
    // This participant's own first track map: every mid the backend just filled from an already-connected participant's producer, reported immediately rather than waiting for a second round trip.
    if (result.consumed.length > 0) {
      const consumedEntries = result.consumed.map((track) => {
        const owner = [...participants.values()].find(
          (candidate) => candidate.participantId === track.fromParticipantId,
        );
        return {
          mid: track.mid,
          member: owner?.deviceId ?? entry.deviceId,
          kind: track.kind,
        };
      });
      await sendTrackMap(entry, consumedEntries);
    }
    // Every other participant now has one more live track (this joiner's own) to report.
    for (const other of participants.values()) {
      if (other.participantId === entry.participantId) {
        continue;
      }
      await republishTo(other.participantId);
    }
  }

  async function handleIceCandidate(
    entry: Readonly<ParticipantEntry>,
    incoming: Readonly<IncomingManageRequest>,
    message: Readonly<WebrtcIceCandidate>,
  ): Promise<void> {
    await backend.addIceCandidate(
      entry.participantId,
      message.candidate !== undefined
        ? rtcIceCandidateInitFromWire(message.candidate)
        : null,
    );
    await incoming.respond({ result: "ok" });
  }

  async function consumeParticipant(entry: ParticipantEntry): Promise<void> {
    for await (const incoming of entry.session.incomingManageRequests) {
      if (incoming.command.verb !== WEBRTC_SIGNAL_VERB) {
        continue;
      }
      const params = incoming.command.params;
      if (isWebrtcOffer(params)) {
        await handleOffer(entry, incoming, params);
      } else if (isWebrtcIceCandidate(params)) {
        await handleIceCandidate(entry, incoming, params);
      } else if (isWebrtcAnswer(params) || isSfuTrackMap(params)) {
        // An ordinary participant never sends either: webrtc.answer only ever answers this SFU's own offer (this SFU never offers), and webrtc.sfu-track-map is this SFU's own outbound-only report. Answered so a misbehaving or confused peer doesn't hang waiting for a response that will never come, never dispatched further.
        await incoming.respond({ result: "error", code: "unexpected-verb" });
      }
    }
  }

  return {
    async addParticipant(deviceId, session) {
      const participantId = participantIdFor(deviceId);
      const entry: ParticipantEntry = { deviceId, session, participantId };
      participants.set(participantId, entry);
      await consumeParticipant(entry);
    },
    async removeParticipant(deviceId) {
      const participantId = participantIdFor(deviceId);
      const entry = participants.get(participantId);
      if (entry === undefined) {
        return;
      }
      participants.delete(participantId);
      liveTracks.delete(participantId);
      const affected = await backend.leave(participantId);
      for (const otherParticipantId of affected) {
        await republishTo(otherParticipantId);
      }
    },
    get participantCount() {
      return participants.size;
    },
  };
}
