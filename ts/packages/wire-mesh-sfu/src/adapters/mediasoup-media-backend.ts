// The one real SfuMediaBackend implementation this package ships: wraps a single mediasoup Worker/Router, one WebRtcTransport per joined participant, and sdp-bridge.ts's own SDP<->RtpParameters translation. Leans on mediasoup rather than a from-scratch RTP forwarder for the same audited-library-over-reimplementation reasoning the design settled on FROST threshold signing with (wire-mesh#29, wire-mesh#37).
//
// DTLS role: this backend always answers with a=setup:active (this SFU initiates the DTLS handshake as the client), so the remote's own dtlsParameters.role passed to transport.connect() is always "server", its complement. Either choice is a valid DTLS negotiation outcome for an offer proposing a=setup:actpass; this is a deliberate, fixed pick for simplicity, not a constraint mediasoup or the browser imposes.
//
// Scope: one recv slot per already-proposed recvonly m-line, filled from whichever other participant's matching-kind producer is available first, never reassigned once filled. A participant joining after another's own recvonly slots are already exhausted (or already filled) is not connected to it without a later renegotiation this backend does not drive: see this package's README for the fuller explanation and what a later version would add.

import { createWorker } from "mediasoup";
import type {
  Consumer,
  DtlsFingerprint,
  DtlsRole,
  FingerprintAlgorithm,
  Producer,
  Router,
  RtpCodecCapability,
  RtpHeaderExtensionUri,
  RtpParameters,
  Worker,
  WebRtcTransport,
} from "mediasoup/types";
import {
  buildAnswer,
  intersectWithRouterCapabilities,
  parseOffer,
  type AnswerSection,
  type BridgeRtpParameters,
} from "./sdp-bridge.js";
import type { BackendTrack, SfuMediaBackend } from "../domain/media-backend.js";

export interface MediasoupMediaBackendOptions {
  /** The local address mediasoup's own WebRtcTransport listens on for every participant. */
  listenIp: string;
  /** The address advertised in ICE candidates in place of listenIp, for a host behind NAT (a cloud VM's own public IP, a container's host-mapped port). Omit for same-host/same-LAN deployments, where listenIp is already reachable. */
  announcedIp?: string;
  /** Router-level codec set. Defaults to Opus and VP8, the two codecs virtually every browser offers: see this package's README for adding more. */
  mediaCodecs?: readonly RtpCodecCapability[];
}

const DEFAULT_MEDIA_CODECS: RtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 0,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    preferredPayloadType: 0,
  },
];

// This backend's own fixed DTLS role choice (see module header) and its complement, the role told to mediasoup for the remote (browser) peer.
const OUR_DTLS_SETUP = "active" as const;
const REMOTE_DTLS_ROLE: DtlsRole = "server";

interface ConsumerRegistration {
  participantId: string;
  mid: string;
  consumer: Consumer;
}

interface ParticipantState {
  transport: WebRtcTransport;
  /** This participant's own outbound tracks, keyed by their local mid. */
  producers: Map<string, Producer>;
  /** Tracks forwarded to this participant, keyed by the mid this backend assigned when filling its own recvonly slot. */
  consumers: Map<string, Consumer>;
}

// Every RTP header extension mediasoup itself understands (RtpHeaderExtensionUri's own literal union): a browser offer routinely proposes several this backend has no use for or mediasoup rejects outright, so headerExtensions is filtered down to this set, never passed through verbatim, at the one place (produce()) mediasoup actually validates it.
const MEDIASOUP_HEADER_EXTENSION_URIS: ReadonlySet<string> = new Set([
  "urn:ietf:params:rtp-hdrext:sdes:mid",
  "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
  "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id",
  "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
  "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
  "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
  "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension",
  "urn:3gpp:video-orientation",
  "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time",
  "urn:ietf:params:rtp-hdrext:toffset",
  "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
  "urn:mediasoup:params:rtp-hdrext:packet-id",
] satisfies RtpHeaderExtensionUri[]);

/** Narrows a whole header-extension entry (its uri and id together), not just its bare uri string, so Array.prototype.filter's own predicate-based type narrowing applies to the array element type directly and no cast is needed at the call site. */
function isMediasoupHeaderExtension(
  extension: Readonly<{ uri: string; id: number }>,
): extension is { uri: RtpHeaderExtensionUri; id: number } {
  return MEDIASOUP_HEADER_EXTENSION_URIS.has(extension.uri);
}

/** Converts this bridge's own provider-neutral BridgeRtpParameters (sdp-bridge.ts, no mediasoup dependency) into mediasoup's real RtpParameters, at the one place the two worlds actually meet. */
function toMediasoupRtpParameters(
  bridge: Readonly<BridgeRtpParameters>,
): RtpParameters {
  return {
    mid: bridge.mid,
    codecs: bridge.codecs,
    ...(bridge.headerExtensions !== undefined
      ? {
          headerExtensions: bridge.headerExtensions.filter(
            isMediasoupHeaderExtension,
          ),
        }
      : {}),
    ...(bridge.encodings !== undefined ? { encodings: bridge.encodings } : {}),
    ...(bridge.rtcp !== undefined ? { rtcp: bridge.rtcp } : {}),
  };
}

// RFC 8122's own hash-func grammar (the a=fingerprint algorithm token) is exactly mediasoup's own FingerprintAlgorithm union; a real DTLS stack's offer never carries anything else, but this is still checked explicitly (never assumed via a cast) so a genuinely malformed offer fails loudly here rather than silently reaching mediasoup with a value it doesn't recognise.
const FINGERPRINT_ALGORITHMS: ReadonlySet<string> = new Set([
  "sha-1",
  "sha-224",
  "sha-256",
  "sha-384",
  "sha-512",
] satisfies FingerprintAlgorithm[]);

function isFingerprintAlgorithm(value: string): value is FingerprintAlgorithm {
  return FINGERPRINT_ALGORITHMS.has(value);
}

/** sdp-transform's own a=fingerprint field names (`{type, hash}`) and mediasoup's own DtlsFingerprint (`{algorithm, value}`) describe the identical RFC 4572 value under different field names, converted at this one boundary rather than trying to unify sdp-bridge.ts's provider-neutral type with mediasoup's own. */
function toDtlsFingerprint(
  fingerprint: Readonly<{ type: string; hash: string }>,
): DtlsFingerprint {
  if (!isFingerprintAlgorithm(fingerprint.type)) {
    throw new Error(
      `offer's own a=fingerprint carries an unrecognised algorithm: ${fingerprint.type}`,
    );
  }
  return { algorithm: fingerprint.type, value: fingerprint.hash };
}

function fromDtlsFingerprint(fingerprint: Readonly<DtlsFingerprint>): {
  type: string;
  hash: string;
} {
  return { type: fingerprint.algorithm, hash: fingerprint.value };
}

function toRouterCodec(codec: Readonly<RtpCodecCapability>): {
  mimeType: string;
  clockRate: number;
  channels?: number;
} {
  return {
    mimeType: codec.mimeType,
    clockRate: codec.clockRate,
    ...(codec.channels !== undefined ? { channels: codec.channels } : {}),
  };
}

function bridgeParametersFromConsumer(
  mid: string,
  consumer: Readonly<Consumer>,
): BridgeRtpParameters {
  return {
    mid,
    codecs: consumer.rtpParameters.codecs.map((codec) => ({
      mimeType: codec.mimeType,
      payloadType: codec.payloadType,
      clockRate: codec.clockRate,
      ...(codec.channels !== undefined ? { channels: codec.channels } : {}),
      ...(codec.parameters !== undefined
        ? {
            parameters: Object.fromEntries(
              Object.entries(codec.parameters).map(([key, value]) => [
                key,
                typeof value === "number" || typeof value === "string"
                  ? value
                  : String(value),
              ]),
            ),
          }
        : {}),
      ...(codec.rtcpFeedback !== undefined && codec.rtcpFeedback.length > 0
        ? {
            rtcpFeedback: codec.rtcpFeedback.map((feedback) => ({
              type: feedback.type,
              ...(feedback.parameter !== undefined && feedback.parameter !== ""
                ? { parameter: feedback.parameter }
                : {}),
            })),
          }
        : {}),
    })),
    encodings: (consumer.rtpParameters.encodings ?? [])
      .filter(
        (encoding): encoding is { ssrc: number } => encoding.ssrc !== undefined,
      )
      .map((encoding) => ({ ssrc: encoding.ssrc })),
    ...(consumer.rtpParameters.rtcp?.cname !== undefined
      ? { rtcp: { cname: consumer.rtpParameters.rtcp.cname } }
      : {}),
  };
}

export async function createMediasoupMediaBackend(
  options: Readonly<MediasoupMediaBackendOptions>,
): Promise<SfuMediaBackend> {
  const worker: Worker = await createWorker();
  const mediaCodecs = options.mediaCodecs ?? DEFAULT_MEDIA_CODECS;
  const router: Router = await worker.createRouter({
    mediaCodecs: [...mediaCodecs],
  });
  const participants = new Map<string, ParticipantState>();
  // Every OTHER participant's consumer of one participant's producer, keyed by that producer's own mediasoup id: leave() uses this to close and report every downstream consumer when its owning producer's participant disconnects.
  const consumersByProducerId = new Map<string, Set<ConsumerRegistration>>();

  function findAvailableProducer(
    kind: "audio" | "video",
    excludeParticipantId: string,
    alreadyConsumedProducerIds: ReadonlySet<string>,
  ): { participantId: string; producer: Producer } | undefined {
    for (const [participantId, state] of participants) {
      if (participantId === excludeParticipantId) {
        continue;
      }
      for (const producer of state.producers.values()) {
        if (
          producer.kind === kind &&
          !alreadyConsumedProducerIds.has(producer.id)
        ) {
          return { participantId, producer };
        }
      }
    }
    return undefined;
  }

  return {
    async join(participantId, offerSdp) {
      const offer = parseOffer(offerSdp);
      const transport = await router.createWebRtcTransport({
        listenIps: [
          {
            ip: options.listenIp,
            ...(options.announcedIp !== undefined
              ? { announcedIp: options.announcedIp }
              : {}),
          },
        ],
        enableUdp: true,
        enableTcp: true,
      });
      const producers = new Map<string, Producer>();
      const consumers = new Map<string, Consumer>();
      participants.set(participantId, { transport, producers, consumers });

      const produced: BackendTrack[] = [];
      const consumed: (BackendTrack & { fromParticipantId: string })[] = [];
      const answerSections: AnswerSection[] = [];
      const consumedProducerIds = new Set<string>();

      for (const section of offer.sections) {
        if (section.kind === "other") {
          answerSections.push({
            mid: section.mid,
            kind: "other",
            direction: "inactive",
          });
          continue;
        }
        if (section.send !== undefined) {
          const narrowed = intersectWithRouterCapabilities(
            section.send,
            router.rtpCapabilities.codecs?.map(toRouterCodec) ?? [],
          );
          if (narrowed !== undefined) {
            const producer = await transport.produce({
              kind: section.kind,
              rtpParameters: toMediasoupRtpParameters(narrowed),
            });
            producers.set(section.mid, producer);
            produced.push({ mid: section.mid, kind: section.kind });
          }
          answerSections.push({
            mid: section.mid,
            kind: section.kind,
            direction: "inactive",
          });
          continue;
        }
        if (section.canReceive) {
          const available = findAvailableProducer(
            section.kind,
            participantId,
            consumedProducerIds,
          );
          if (
            available !== undefined &&
            router.canConsume({
              producerId: available.producer.id,
              rtpCapabilities: router.rtpCapabilities,
            })
          ) {
            const consumer = await transport.consume({
              producerId: available.producer.id,
              rtpCapabilities: router.rtpCapabilities,
              mid: section.mid,
            });
            consumers.set(section.mid, consumer);
            consumedProducerIds.add(available.producer.id);
            const registrations =
              consumersByProducerId.get(available.producer.id) ?? new Set();
            registrations.add({ participantId, mid: section.mid, consumer });
            consumersByProducerId.set(available.producer.id, registrations);
            const track = { mid: section.mid, kind: section.kind };
            consumed.push({
              ...track,
              fromParticipantId: available.participantId,
            });
            answerSections.push({
              mid: section.mid,
              kind: section.kind,
              direction: "sendonly",
              rtpParameters: bridgeParametersFromConsumer(
                section.mid,
                consumer,
              ),
            });
            continue;
          }
        }
        answerSections.push({
          mid: section.mid,
          kind: section.kind,
          direction: "inactive",
        });
      }

      await transport.connect({
        dtlsParameters: {
          role: REMOTE_DTLS_ROLE,
          fingerprints: [toDtlsFingerprint(offer.iceDtls.fingerprint)],
        },
      });

      const fingerprint =
        transport.dtlsParameters.fingerprints.find(
          (candidate) => candidate.algorithm === "sha-256",
        ) ?? transport.dtlsParameters.fingerprints[0];
      if (fingerprint === undefined) {
        throw new Error("mediasoup transport reported no DTLS fingerprints");
      }

      const answerSdp = buildAnswer({
        sections: answerSections,
        iceUfrag: transport.iceParameters.usernameFragment,
        icePwd: transport.iceParameters.password,
        fingerprint: fromDtlsFingerprint(fingerprint),
        candidates: transport.iceCandidates.map((candidate) => ({
          foundation: candidate.foundation,
          priority: candidate.priority,
          ip: candidate.address,
          port: candidate.port,
          protocol: candidate.protocol,
          type: candidate.type,
        })),
        dtlsSetup: OUR_DTLS_SETUP,
      });

      return { answerSdp, produced, consumed };
    },

    // Neither parameter is read: TypeScript's own function-type compatibility allows a narrower-arity implementation to satisfy a wider interface signature (excess call-site arguments are simply never bound), so this genuinely takes none rather than declaring and discarding two. addIceCandidate is part of SfuMediaBackend's own contract (a full, non-lite ICE agent backend would genuinely need to forward the candidate onward), but mediasoup's ICE Lite transport never needs the remote's own candidates at all (see this file's own module header and media-backend.ts's addIceCandidate doc comment), so this implementation has nothing to do with either argument; the await below is a real yield to the microtask queue, not a disguised synchronous return, since this workspace's own async/require-await lint rules require every Promise-returning function to genuinely be async.
    async addIceCandidate(): Promise<void> {
      await Promise.resolve();
    },

    async leave(participantId) {
      // mediasoup's own close() calls below are all synchronous (Transport/Producer/Consumer.close(): void); this await exists only to make this genuinely async per this workspace's own require-await/promise-function-async rules, the same reasoning addIceCandidate's own comment above gives in full.
      await Promise.resolve();
      const state = participants.get(participantId);
      if (state === undefined) {
        return [];
      }
      participants.delete(participantId);
      const affected = new Set<string>();
      for (const producer of state.producers.values()) {
        const registrations = consumersByProducerId.get(producer.id);
        if (registrations !== undefined) {
          for (const registration of registrations) {
            registration.consumer.close();
            participants
              .get(registration.participantId)
              ?.consumers.delete(registration.mid);
            affected.add(registration.participantId);
          }
          consumersByProducerId.delete(producer.id);
        }
      }
      state.transport.close();
      return [...affected];
    },
  };
}
