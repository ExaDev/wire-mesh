/**
 * The participant side of the real, wire-driven `exadev.io/threshold:sign` protocol: consumes a `MeshSession`'s `incomingManageRequests`, answers `threshold.commit`/`threshold.sign`/`threshold.abort` using the real wasm-backed FROST crypto (`adapters/threshold-wasm.ts`), and mints each round-2 share as a real `threshold-share-envelope` (`domain/threshold-share-envelope.ts`) signed under this device's own PERSONAL identity, never the group's. The coordinator-facing counterpart is `adapters/threshold-network-coordinator.ts`'s `createThresholdNetworkCoordinator`.
 *
 * Returning a round-1 commitment IS this participant's act of authorisation (`domain/threshold-subject.ts`'s own comment) -- `authorise` runs BEFORE any commitment is produced, and `refuseUnrecognisedKind` is always checked first regardless of what `authorise` itself returns, since an unrecognised `kind` is this spec's own non-negotiable fail-closed default.
 */
import type { DeviceId } from "../generated/protocol.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityPort } from "../ports/identity.js";
import type { NonceStore } from "../ports/nonce-store.js";
import { deviceIdToHex } from "../domain/device-id.js";
import type {
  IncomingManageRequest,
  MeshSession,
} from "../domain/mesh-session.js";
import {
  THRESHOLD_GROUP_SCOPE,
  THRESHOLD_SIGN_VERB,
  isThresholdAbort,
  isThresholdCommit,
  isThresholdSign,
} from "../domain/threshold-network.js";
import { mintShareEnvelope } from "../domain/threshold-share-envelope.js";
import { encodeShareEnvelope } from "../domain/threshold-share-wire.js";
import {
  refuseUnrecognisedKind,
  toBeSigned,
  type SubjectDecision,
  type ThresholdSubject,
} from "../domain/threshold-subject.js";
import {
  type RevocationCheck,
  verifyCapabilityToken,
} from "../domain/tokens.js";
import {
  combineCommitments,
  signingBuildPackage,
  signingRound1Commit,
  signingRound2Sign,
  splitCommitments,
  type DeviceKeyed,
} from "./threshold-wasm.js";

/** The subset of MeshSession this responder actually consumes. */
export type ThresholdParticipantSession = Pick<
  MeshSession,
  "incomingManageRequests"
>;

export interface ThresholdParticipantOptions {
  session: Readonly<ThresholdParticipantSession>;
  /** This participant's own personal signing identity -- what every round-2 share-envelope is minted under, never the group's own key. Also doubles as the `identity` a request's own capability token is checked against: token verification is a property of the given key, not the local identity, so this participant's own identity works for that role too (see verifyShareEnvelope's own doc comment for the identical reasoning applied to an envelope's issuer-key). */
  personalIdentity: Readonly<IdentityPort>;
  /** This participant's own FROST key package bytes, keyed by the owning group's device-id (lowercase hex, via deviceIdToHex) -- a participant may hold a share in more than one group. */
  keyPackagesByGroup: ReadonlyMap<string, Uint8Array>;
  nonceStore: Readonly<NonceStore>;
  clock: Readonly<Clock>;
  /** No silent default: a caller with no revocation-gossip ingestion wired yet must opt in explicitly (e.g. web-console's own exported `noRevocationCheck`), matching webrtc-signaling.ts's own convention for exactly this situation. */
  revocation: Readonly<RevocationCheck>;
  /** Runs after refuseUnrecognisedKind already passed -- an additional, caller-supplied content policy over a subject this participant is being asked to co-sign. Returning undefined defers to "authorised" (refuseUnrecognisedKind's own pass is enough on its own); returning a decision short-circuits either way. Absent, every recognised kind is authorised with no further scrutiny. */
  authorise?: (
    subject: Readonly<ThresholdSubject>,
  ) => SubjectDecision | undefined;
}

interface SigningSessionState {
  message: Uint8Array;
  keyPackage: Uint8Array;
  group: DeviceId;
}

/** True when an incoming threshold.commit/.sign/.abort carries a currently-valid exadev.io/threshold:sign token scoped to "group" -- mirrors authorizeIncomingOffer's own exact structure (webrtc-signaling.ts) for the sibling domain. expectedBearer is deliberately not checked, for the identical reason that function documents: neither a browser client's MeshSession nor a relay-routed one exposes a way to learn a peer's device-id independently of the token itself. */
async function authorizeIncomingRequest(
  incoming: Readonly<IncomingManageRequest>,
  options: Readonly<ThresholdParticipantOptions>,
): Promise<boolean> {
  if (incoming.token === undefined) {
    return false;
  }
  const verdict = await verifyCapabilityToken(incoming.token, {
    identity: options.personalIdentity,
    clock: options.clock,
    revocation: options.revocation,
  });
  if (!verdict.ok) {
    return false;
  }
  return (
    verdict.claims.capability === THRESHOLD_SIGN_VERB &&
    verdict.claims.scope.kind === THRESHOLD_GROUP_SCOPE.kind
  );
}

/**
 * Starts consuming `session.incomingManageRequests`, answering threshold.commit/.sign/.abort for as long as the underlying stream produces requests. Returns nothing to await -- like `webrtc-negotiation.ts`'s own `consumeIncoming`, this is a fire-and-forget background loop for the lifetime of the session; a caller that needs to stop it closes the session itself (there is no separate cancellation handle, matching this package's own MeshSession lifecycle).
 */
export function startThresholdParticipant(
  options: Readonly<ThresholdParticipantOptions>,
): void {
  const sessions = new Map<string, SigningSessionState>();

  function decide(subject: Readonly<ThresholdSubject>): SubjectDecision {
    const refusal = refuseUnrecognisedKind(subject);
    if (refusal !== undefined) {
      return refusal;
    }
    return options.authorise?.(subject) ?? { authorise: true };
  }

  async function handleCommit(
    incoming: Readonly<IncomingManageRequest>,
    params: {
      "session-id": number;
      group: DeviceId;
      subject: ThresholdSubject;
      deadline: number;
    },
  ): Promise<void> {
    if (params.deadline <= options.clock.now()) {
      await incoming.respond({ result: "error", code: "deadline-passed" });
      return;
    }
    const keyPackage = options.keyPackagesByGroup.get(
      deviceIdToHex(params.group),
    );
    if (keyPackage === undefined) {
      await incoming.respond({ result: "error", code: "unknown-group" });
      return;
    }
    const decision = decide(params.subject);
    if (!decision.authorise) {
      await incoming.respond({
        result: "error",
        code: "refused",
        message: decision.reason,
      });
      return;
    }

    const sessionKey = String(params["session-id"]);
    const message = toBeSigned(params.subject);
    const { nonces, commitments } = signingRound1Commit(keyPackage);
    await options.nonceStore.persist(BigInt(params["session-id"]), nonces);
    sessions.set(sessionKey, { message, keyPackage, group: params.group });

    const { hiding, binding } = splitCommitments(commitments);
    await incoming.respond({
      result: "ok",
      participant: options.personalIdentity.deviceId,
      hiding,
      binding,
    });
  }

  async function handleSign(
    incoming: Readonly<IncomingManageRequest>,
    params: {
      "session-id": number;
      commitments: readonly {
        participant: Uint8Array;
        hiding: Uint8Array;
        binding: Uint8Array;
      }[];
    },
  ): Promise<void> {
    const sessionKey = String(params["session-id"]);
    const sessionId = BigInt(params["session-id"]);
    const state = sessions.get(sessionKey);
    if (state === undefined) {
      await options.nonceStore.discard(sessionId);
      await incoming.respond({
        result: "error",
        code: "no-such-session",
        message:
          "threshold.sign for a session-id with no prior threshold.commit",
      });
      return;
    }

    let nonces: Uint8Array;
    try {
      nonces = await options.nonceStore.take(sessionId);
    } catch {
      sessions.delete(sessionKey);
      await incoming.respond({
        result: "error",
        code: "nonce-unavailable",
        message:
          "no persisted, unused nonce pair for this session -- already released, expired, or never persisted",
      });
      return;
    }

    const commitmentEntries: DeviceKeyed[] = params.commitments.map((c) => ({
      deviceId: Uint8Array.from(c.participant),
      value: combineCommitments(c.hiding, c.binding),
    }));
    const signingPackage = signingBuildPackage(
      commitmentEntries,
      state.message,
    );
    const share = signingRound2Sign(nonces, signingPackage, state.keyPackage);

    const envelope = await mintShareEnvelope(
      options.personalIdentity,
      sessionId,
      state.group,
      share,
    );
    sessions.delete(sessionKey);
    await incoming.respond({
      result: "ok",
      share: encodeShareEnvelope(envelope),
    });
  }

  async function handleAbort(
    incoming: Readonly<IncomingManageRequest>,
    params: Readonly<{ "session-id": number }>,
  ): Promise<void> {
    const sessionId = BigInt(params["session-id"]);
    sessions.delete(String(params["session-id"]));
    await options.nonceStore.discard(sessionId);
    await incoming.respond({ result: "ok" });
  }

  async function consume(): Promise<void> {
    for await (const incoming of options.session.incomingManageRequests) {
      if (incoming.command.verb !== THRESHOLD_SIGN_VERB) {
        continue;
      }
      const authorized = await authorizeIncomingRequest(incoming, options);
      if (!authorized) {
        await incoming.respond({ result: "error", code: "unauthorized" });
        continue;
      }
      const params = incoming.command.params;
      if (isThresholdCommit(params)) {
        await handleCommit(incoming, {
          "session-id": params["session-id"],
          group: params.group,
          subject: params.subject,
          deadline: params.deadline,
        });
      } else if (isThresholdSign(params)) {
        await handleSign(incoming, {
          "session-id": params["session-id"],
          commitments: params.commitments,
        });
      } else if (isThresholdAbort(params)) {
        await handleAbort(incoming, { "session-id": params["session-id"] });
      }
    }
  }
  void consume();
}
