/**
 * A real, wire-driven `ThresholdCoordinator` (`adapters/threshold-identity.ts`): drives the two-round FROST signing protocol over actual `manage-request`/`manage-response` traffic through a `MeshSession`, exactly as `core/webrtc`'s own negotiation does (`webrtc-negotiation.ts`'s own `session.sendManageRequest` usage is the precedent this module mirrors). The prior in-process-only wiring (every participant simulated locally, no network) was `threshold-identity.unit.test.ts`'s own test double; this is the real implementation the group's coordinator role actually runs.
 */
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
} from "../generated/protocol.js";
import type { IdentityPort } from "../ports/identity.js";
import type { ManageOutcome, MeshSession } from "../domain/mesh-session.js";
import { bytesEqual } from "../domain/token-scope.js";
import {
  THRESHOLD_GROUP_SCOPE,
  buildCommitCommand,
  buildSignCommand,
} from "../domain/threshold-network.js";
import { decodeShareEnvelopeBytes } from "../domain/threshold-share-wire.js";
import { verifyShareEnvelope } from "../domain/threshold-share-envelope.js";
import {
  combineCommitments,
  splitCommitments,
  type DeviceKeyed,
} from "./threshold-wasm.js";
import type {
  SignatureShareEntry,
  SigningCommitmentEntry,
  ThresholdCoordinator,
} from "./threshold-identity.js";

/** The subset of MeshSession this module actually needs -- never the full session surface, matching this project's own minimal-contract convention. Both createThresholdNetworkCoordinator and createThresholdParticipant depend on exactly this same narrow type, never the full MeshSession, so either can be satisfied by a session, a relay-routed session, or a lighter test double with no other MeshSession machinery. */
export type ThresholdSessionTransport = Pick<MeshSession, "sendManageRequest">;

export interface ThresholdNetworkCoordinatorOptions {
  session: Readonly<ThresholdSessionTransport>;
  /** The group's own device-id -- carried on every threshold.commit request. */
  group: DeviceId;
  /** Verifies each collected round-2 share-envelope's self-certification/signature before extracting its raw share. Verification needs no local private key, only the envelope's own embedded issuer-key (see verifyShareEnvelope's own doc comment) -- this is typically the coordinator's own IdentityPort, reused for its ordinary verify capability, not a separate credential. */
  verifierIdentity: Readonly<IdentityPort>;
  scope?: Readonly<CapabilityScope>;
  token?: CapabilityToken;
  timeoutMs?: number;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isDeviceIdShaped(value: unknown): value is DeviceId {
  const DEVICE_ID_BYTE_LENGTH = 32;
  return isUint8Array(value) && value.length === DEVICE_ID_BYTE_LENGTH;
}

interface CommitOkFields {
  participant: DeviceId;
  hiding: Uint8Array;
  binding: Uint8Array;
}

/** Parses threshold-commit's own manage-ok extension: `participant: device-id, hiding: bstr, binding: bstr`. Returns undefined for anything malformed -- an unauthorised, malformed, or non-responding participant is simply excluded from this round's result, matching commitRound's own documented "either returns enough commitments to proceed or rejects" contract (the caller, ThresholdIdentity.signSubject, is what enforces the threshold count). */
function parseCommitOk(
  outcome: Readonly<ManageOutcome>,
): CommitOkFields | undefined {
  if (outcome.result !== "ok") {
    return undefined;
  }
  const { participant, hiding, binding } = outcome;
  if (
    !isDeviceIdShaped(participant) ||
    !isUint8Array(hiding) ||
    !isUint8Array(binding)
  ) {
    return undefined;
  }
  return { participant, hiding, binding };
}

/**
 * Builds a ThresholdCoordinator that drives commitRound/signRound over a real MeshSession. `group` and `verifierIdentity` are fixed for this coordinator's whole lifetime (a coordinator instance is scoped to one group), matching ThresholdCoordinator's own contract, which deliberately carries no group/verifier parameters of its own -- those are this adapter's own construction-time configuration, not part of the transport-agnostic interface every implementation shares.
 */
export function createThresholdNetworkCoordinator(
  options: Readonly<ThresholdNetworkCoordinatorOptions>,
): ThresholdCoordinator {
  const scope = options.scope ?? THRESHOLD_GROUP_SCOPE;

  return {
    async commitRound(sessionId, participants, subject, deadlineUnixMs) {
      const command = buildCommitCommand(
        sessionId,
        options.group,
        subject,
        deadlineUnixMs,
      );
      const responses = await Promise.all(
        participants.map(
          async (participant): Promise<SigningCommitmentEntry | undefined> => {
            const outcome = await options.session.sendManageRequest(
              command,
              scope,
              participant,
              options.token,
              options.timeoutMs,
            );
            const parsed = parseCommitOk(outcome);
            if (parsed === undefined) {
              return undefined;
            }
            if (!bytesEqual(parsed.participant, participant)) {
              return undefined;
            }
            return {
              deviceId: participant,
              value: combineCommitments(parsed.hiding, parsed.binding),
            };
          },
        ),
      );
      return responses.filter(
        (entry): entry is SigningCommitmentEntry => entry !== undefined,
      );
    },

    async signRound(sessionId, commitments) {
      const wireCommitments = commitments.map((entry: DeviceKeyed) => {
        const { hiding, binding } = splitCommitments(entry.value);
        return { participant: entry.deviceId, hiding, binding };
      });
      const command = buildSignCommand(sessionId, wireCommitments);

      const responses = await Promise.all(
        commitments.map(
          async ({
            deviceId: participant,
          }): Promise<SignatureShareEntry | undefined> => {
            const outcome = await options.session.sendManageRequest(
              command,
              scope,
              participant,
              options.token,
              options.timeoutMs,
            );
            if (outcome.result !== "ok") {
              return undefined;
            }
            const shareBytes = outcome.share;
            if (!isUint8Array(shareBytes)) {
              return undefined;
            }
            const envelope = decodeShareEnvelopeBytes(shareBytes);
            if (envelope === undefined) {
              return undefined;
            }
            const claims = await verifyShareEnvelope(
              options.verifierIdentity,
              envelope,
            );
            if (claims === undefined) {
              return undefined;
            }
            // The envelope must be for THIS session and group, and issued by the exact participant this request was addressed to -- an envelope can be validly signed by its own issuer and still be the wrong envelope for this round (replayed from a different session, or from a different participant entirely), matching unwrap_and_aggregate's own checks on the Rust side.
            if (
              claims.sessionId !== sessionId ||
              !bytesEqual(claims.group, options.group) ||
              !bytesEqual(claims.issuer, participant)
            ) {
              return undefined;
            }
            return { deviceId: participant, value: claims.share };
          },
        ),
      );
      return responses.filter(
        (entry): entry is SignatureShareEntry => entry !== undefined,
      );
    },
  };
}
