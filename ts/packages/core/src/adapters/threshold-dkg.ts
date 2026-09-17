/**
 * Real, wire-driven DKG/reshare session orchestration for `exadev.io/threshold` (wire-mesh#171): the layer `ThresholdIdentity`/`ThresholdCoordinator` already provide for signing, but DKG has no coordinator/participant asymmetry to build on -- every device runs the IDENTICAL choreography (broadcast round 1, exchange round 2 pairwise, confirm), matching Pedersen DKG's own peer-to-peer structure. `runFreshThresholdDkg` is the entry point a caller drives once per device in the ceremony; every device calls it with the SAME `sessionId` and `participants` set.
 *
 * Distinguishing which peer sent an incoming round1/round2/confirm message requires `IncomingManageRequest.fromDevice`, which `MeshSession` only populates for a relay-routed request (see mesh-session.ts's own doc comment on that field) -- the same reliance `webrtc-negotiation.ts`'s own `handleIncomingOffer` already has on `incoming.fromDevice` for addressing a specific peer. A direct, unrelayed one-to-one MeshSession has no way to disambiguate more than one concurrent peer and is therefore not a fit for this module's own multi-party choreography.
 */
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
} from "../generated/protocol.js";
import { deviceIdToHex } from "../domain/device-id.js";
import type { MeshSession } from "../domain/mesh-session.js";
import { bytesEqual } from "../domain/token-scope.js";
import {
  buildKeygenConfirmCommand,
  buildKeygenRound1Command,
  buildKeygenRound2Command,
  isThresholdKeygenConfirm,
  isThresholdKeygenRound1,
  isThresholdKeygenRound2,
  keygenCapabilityVerb,
  THRESHOLD_GROUP_SCOPE,
} from "../domain/threshold-network.js";
import {
  combineRound1Package,
  dkgConfirmMatches,
  dkgRound1,
  dkgRound2,
  dkgRound3,
  dkgTranscriptDigest,
  keyPackageSigningShare,
  reshareCombineCommitmentParts,
  reshareCombineCommitments,
  reshareCombineReceivedShares,
  reshareDerivePublicKeyPackage,
  reshareRound1,
  reshareSplitCommitment,
  reshareTranscriptDigest,
  splitRound1Package,
  type DeviceKeyed,
} from "./threshold-wasm.js";

/** The subset of MeshSession one participant's DKG/reshare choreography needs -- both directions, since every device is simultaneously a sender (broadcasting its own round1/round2/confirm) and a receiver (of every other participant's). */
export type ThresholdDkgTransport = Pick<
  MeshSession,
  "sendManageRequest" | "incomingManageRequests"
>;

export interface ThresholdDkgResult {
  keyPackage: Uint8Array<ArrayBuffer>;
  publicKeyPackage: Uint8Array<ArrayBuffer>;
  groupVerifyingKey: Uint8Array<ArrayBuffer>;
}

interface PendingWaiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/** One (verb-family, session-id)'s worth of per-sender-device delivery: a message that arrives before anyone is waiting for it is buffered; a waiter that arrives before the message does is queued. Mirrors mesh-session.ts's own backlog/waiter pattern for its incomingManageRequests iterator, scoped down to "exactly one value per device-id" rather than an ordered stream. */
class PerDeviceCollector<T> {
  private readonly waiters = new Map<string, PendingWaiter<T>>();
  private readonly backlog = new Map<string, T>();
  private failure: Error | undefined;

  async awaitFrom(deviceHex: string): Promise<T> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const buffered = this.backlog.get(deviceHex);
    if (buffered !== undefined) {
      this.backlog.delete(deviceHex);
      return buffered;
    }
    return new Promise((resolve, reject) => {
      this.waiters.set(deviceHex, { resolve, reject });
    });
  }

  deliver(deviceHex: string, value: T): void {
    const waiter = this.waiters.get(deviceHex);
    if (waiter !== undefined) {
      this.waiters.delete(deviceHex);
      waiter.resolve(value);
    } else {
      this.backlog.set(deviceHex, value);
    }
  }

  /** Aborts every pending and future wait -- the ceremony failed for a reason no single awaitFrom call caused (e.g. a peer sent threshold.abort). */
  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.values()) {
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

interface Round1Payload {
  commitment: Uint8Array[];
  proofOfKnowledge?: Uint8Array;
  existingGroupKey?: Uint8Array;
}

interface ConfirmPayload {
  transcriptDigest: Uint8Array;
  groupKey: Uint8Array;
}

interface DkgCollectors {
  round1: PerDeviceCollector<Round1Payload>;
  round2: PerDeviceCollector<Uint8Array>;
  confirm: PerDeviceCollector<ConfirmPayload>;
}

/** Starts the single shared consume loop for this device's whole DKG/reshare ceremony: every incoming threshold.keygen-round1/round2/confirm for `sessionId`, from whichever peer sent it (via `incoming.fromDevice` -- see this module's own doc comment), is delivered to the matching collector and acknowledged. Anything else (a different session-id, a message with no fromDevice, an unrecognised verb) is left unanswered, matching webrtc-negotiation.ts's own "not this consumer's business" convention for a shared incoming stream. */
function startDkgConsumeLoop(
  session: Readonly<ThresholdDkgTransport>,
  expectedVerb: string,
  sessionId: bigint,
  collectors: Readonly<DkgCollectors>,
): void {
  async function consume(): Promise<void> {
    for await (const incoming of session.incomingManageRequests) {
      if (
        incoming.command.verb !== expectedVerb ||
        incoming.fromDevice === undefined
      ) {
        continue;
      }
      const fromHex = deviceIdToHex(incoming.fromDevice);
      const params = incoming.command.params;
      if (isThresholdKeygenRound1(params)) {
        if (params["session-id"] !== Number(sessionId)) {
          continue;
        }
        collectors.round1.deliver(fromHex, {
          commitment: params.commitment,
          ...(params["proof-of-knowledge"] !== undefined
            ? { proofOfKnowledge: params["proof-of-knowledge"] }
            : {}),
          ...(params["existing-group-key"] !== undefined
            ? { existingGroupKey: params["existing-group-key"] }
            : {}),
        });
        await incoming.respond({ result: "ok" });
      } else if (isThresholdKeygenRound2(params)) {
        if (params["session-id"] !== Number(sessionId)) {
          continue;
        }
        collectors.round2.deliver(fromHex, params.share);
        await incoming.respond({ result: "ok" });
      } else if (isThresholdKeygenConfirm(params)) {
        if (params["session-id"] !== Number(sessionId)) {
          continue;
        }
        collectors.confirm.deliver(fromHex, {
          transcriptDigest: params["transcript-digest"],
          groupKey: params["group-key"],
        });
        await incoming.respond({ result: "ok" });
      }
    }
  }
  void consume();
}

export interface RunFreshThresholdDkgOptions {
  session: Readonly<ThresholdDkgTransport>;
  ownDeviceId: DeviceId;
  /** Every OTHER participant in the ceremony -- this device's own id is never included, matching dkgRound2/dkgRound3's own "MUST NOT include this participant's own package" contract. */
  otherParticipants: readonly DeviceId[];
  threshold: number;
  sessionId: bigint;
  scope?: Readonly<CapabilityScope>;
  token?: CapabilityToken;
  timeoutMs?: number;
}

/** Runs a fresh DKG ceremony's full choreography for ONE device: broadcast round 1, exchange round 2 pairwise, compute round 3 locally, then confirm. Every participant calls this with the identical `sessionId` and `otherParticipants`-plus-`ownDeviceId` set. Rejects (without ever returning a result) if any peer's confirm digest or group key mismatches this device's own -- the ceremony MUST abort, never be repaired in place, per spec/threshold.cddl's own confirm-round obligation. */
export async function runFreshThresholdDkg(
  options: Readonly<RunFreshThresholdDkgOptions>,
): Promise<ThresholdDkgResult> {
  const verb = keygenCapabilityVerb(false);
  const scope = options.scope ?? THRESHOLD_GROUP_SCOPE;
  const maxSigners = options.otherParticipants.length + 1;
  const allParticipants = [options.ownDeviceId, ...options.otherParticipants];
  const collectors: DkgCollectors = {
    round1: new PerDeviceCollector(),
    round2: new PerDeviceCollector(),
    confirm: new PerDeviceCollector(),
  };
  startDkgConsumeLoop(options.session, verb, options.sessionId, collectors);

  const own = dkgRound1(options.ownDeviceId, maxSigners, options.threshold);
  const ownSplit = splitRound1Package(own.package);

  await Promise.all(
    options.otherParticipants.map(async (peer) => {
      const command = buildKeygenRound1Command(
        options.sessionId,
        options.threshold,
        allParticipants,
        ownSplit.commitment,
        { proofOfKnowledge: ownSplit.proofOfKnowledge },
      );
      await options.session.sendManageRequest(
        command,
        scope,
        peer,
        options.token,
        options.timeoutMs,
      );
    }),
  );

  const round1Entries: DeviceKeyed[] = await Promise.all(
    options.otherParticipants.map(async (peer): Promise<DeviceKeyed> => {
      const payload = await collectors.round1.awaitFrom(deviceIdToHex(peer));
      if (payload.proofOfKnowledge === undefined) {
        throw new Error(
          `threshold.keygen-round1 from ${deviceIdToHex(peer)} is missing proof-of-knowledge, REQUIRED for a fresh DKG`,
        );
      }
      return {
        deviceId: peer,
        value: combineRound1Package(
          payload.commitment,
          payload.proofOfKnowledge,
        ),
      };
    }),
  );

  const round2 = dkgRound2(own.secretPackage, round1Entries);

  await Promise.all(
    round2.outgoing.map(async ({ deviceId: peer, value: share }) => {
      const command = buildKeygenRound2Command(options.sessionId, share, false);
      await options.session.sendManageRequest(
        command,
        scope,
        peer,
        options.token,
        options.timeoutMs,
      );
    }),
  );

  const round2Entries: DeviceKeyed[] = await Promise.all(
    options.otherParticipants.map(async (peer): Promise<DeviceKeyed> => {
      const share = await collectors.round2.awaitFrom(deviceIdToHex(peer));
      return { deviceId: peer, value: Uint8Array.from(share) };
    }),
  );

  const round3 = dkgRound3(round2.secretPackage, round1Entries, round2Entries);

  const allRound1Entries: DeviceKeyed[] = [
    { deviceId: options.ownDeviceId, value: own.package },
    ...round1Entries,
  ];
  const ownDigest = dkgTranscriptDigest(
    allRound1Entries,
    round3.groupVerifyingKey,
  );

  await Promise.all(
    options.otherParticipants.map(async (peer) => {
      const command = buildKeygenConfirmCommand(
        options.sessionId,
        ownDigest,
        round3.groupVerifyingKey,
        false,
      );
      await options.session.sendManageRequest(
        command,
        scope,
        peer,
        options.token,
        options.timeoutMs,
      );
    }),
  );

  await Promise.all(
    options.otherParticipants.map(async (peer) => {
      const confirm = await collectors.confirm.awaitFrom(deviceIdToHex(peer));
      const matches = dkgConfirmMatches(
        ownDigest,
        round3.groupVerifyingKey,
        confirm.transcriptDigest,
        confirm.groupKey,
      );
      if (!matches) {
        const error = new Error(
          `DKG echo-broadcast transcript mismatch with ${deviceIdToHex(peer)} -- aborting`,
        );
        collectors.round1.fail(error);
        collectors.round2.fail(error);
        collectors.confirm.fail(error);
        throw error;
      }
    }),
  );

  return round3;
}

// --- Reshare -------------------------------------------------------------
//
// Resharing has no single symmetric choreography the way fresh DKG does: only the T SURVIVORS dealt from an existing share broadcast round 1 and send round 2; every member of the NEW participant set (survivors staying on and brand-new joiners alike) must independently collect all T survivors' round1 broadcasts, derive the combined public key package, and combine whatever round2 shares it received. A device that is both a survivor AND a member of the new set runs BOTH contributeThresholdReshare and joinThresholdReshare concurrently; a survivor that is leaving runs only contributeThresholdReshare (and is done -- it has no new share, no confirm round to take part in); a brand-new device with no prior share runs only joinThresholdReshare.

export interface ContributeThresholdReshareOptions {
  session: Readonly<ThresholdDkgTransport>;
  ownDeviceId: DeviceId;
  /** This survivor's own EXISTING key package for the group being reshared -- reshareRound1 needs only its signing-share bytes (keyPackageSigningShare), never the whole package. */
  ownOldKeyPackage: Uint8Array;
  /** The full T-survivor set, INCLUDING this device. MUST be identical across every survivor's own call for this session-id. */
  survivors: readonly DeviceId[];
  /** The full new participant set this reshare is moving to (may overlap with survivors, may add or drop devices). MUST be identical across every survivor's own call for this session-id. */
  newParticipants: readonly DeviceId[];
  newThreshold: number;
  /** The group's own existing Ed25519 verifying key, echoed on threshold-keygen-round1 as `existing-group-key` so recipients know this is a reshare (not a fresh DKG) of a SPECIFIC, already-known group. */
  existingGroupKey: Uint8Array;
  sessionId: bigint;
  scope?: Readonly<CapabilityScope>;
  token?: CapabilityToken;
  timeoutMs?: number;
}

export interface ReshareContribution {
  commitment: Uint8Array<ArrayBuffer>;
  outgoing: DeviceKeyed[];
  /** This survivor's own round-2 share to itself, present iff this device is also a member of newParticipants -- extracted from `outgoing` so a caller staying in the committee never has to special-case its own entry. */
  shareToSelf?: Uint8Array<ArrayBuffer>;
}

/**
 * The synchronous half of a surviving participant's dealer role: computes its Lagrange-weighted resharing of `ownOldKeyPackage`'s signing share across `newParticipants`. No network I/O -- deliberately split out from `sendReshareContribution` so a device that is ALSO staying in `newParticipants` can start `joinThresholdReshare` (which begins listening immediately) with this result's own `commitment`/`shareToSelf` BEFORE the broadcast sends below have gone anywhere, rather than after: two devices that are both survivors and both new participants would otherwise deadlock, each waiting for the other's `joinThresholdReshare` consume loop to start before either's own send can be acknowledged, while neither starts listening until its own sends finish.
 */
export function computeReshareContribution(
  options: Readonly<
    Pick<
      ContributeThresholdReshareOptions,
      | "ownDeviceId"
      | "ownOldKeyPackage"
      | "survivors"
      | "newParticipants"
      | "newThreshold"
    >
  >,
): ReshareContribution {
  const ownOldShare = keyPackageSigningShare(options.ownOldKeyPackage);
  const r1 = reshareRound1(
    options.ownDeviceId,
    ownOldShare,
    options.survivors,
    options.newParticipants,
    options.newThreshold,
  );
  const shareToSelf = r1.outgoing.find((entry) =>
    bytesEqual(entry.deviceId, options.ownDeviceId),
  )?.value;
  return {
    commitment: r1.commitment,
    outgoing: r1.outgoing,
    ...(shareToSelf !== undefined ? { shareToSelf } : {}),
  };
}

/**
 * The network half of a surviving participant's dealer role: broadcasts round 1 (the commitment) to every recipient other than itself, then sends each recipient's own round-2 share pairwise, from an already-computed `computeReshareContribution` result. Resolves once every send has been acknowledged.
 */
export async function sendReshareContribution(
  options: Readonly<ContributeThresholdReshareOptions>,
  contribution: Readonly<ReshareContribution>,
): Promise<void> {
  const scope = options.scope ?? THRESHOLD_GROUP_SCOPE;
  const commitmentParts = reshareSplitCommitment(contribution.commitment);

  const recipients = options.newParticipants.filter(
    (peer) => !bytesEqual(peer, options.ownDeviceId),
  );
  await Promise.all(
    recipients.map(async (peer) => {
      const command = buildKeygenRound1Command(
        options.sessionId,
        options.newThreshold,
        options.newParticipants,
        commitmentParts,
        { existingGroupKey: options.existingGroupKey },
      );
      await options.session.sendManageRequest(
        command,
        scope,
        peer,
        options.token,
        options.timeoutMs,
      );
    }),
  );

  await Promise.all(
    contribution.outgoing.map(async ({ deviceId: peer, value: share }) => {
      if (bytesEqual(peer, options.ownDeviceId)) {
        return;
      }
      const command = buildKeygenRound2Command(options.sessionId, share, true);
      await options.session.sendManageRequest(
        command,
        scope,
        peer,
        options.token,
        options.timeoutMs,
      );
    }),
  );
}

/**
 * Runs a surviving participant's OWN dealer role end to end: `computeReshareContribution` then `sendReshareContribution`. Only correct for a survivor that is LEAVING the committee (not a member of `newParticipants`) -- it has no further round to take part in, so there is no concurrent listener this call's own sends could deadlock against. A survivor that is ALSO staying in `newParticipants` MUST call `computeReshareContribution` and `sendReshareContribution` separately, starting its own `joinThresholdReshare` (with the computed contribution) concurrently with `sendReshareContribution` -- see that function's own doc comment for why.
 */
export async function contributeThresholdReshare(
  options: Readonly<ContributeThresholdReshareOptions>,
): Promise<ReshareContribution> {
  const contribution = computeReshareContribution(options);
  await sendReshareContribution(options, contribution);
  return contribution;
}

export interface ReshareOwnContribution {
  /** This device's own survivor commitment (contributeThresholdReshare's own return value's `commitment` field), when this device is itself one of the T survivors. */
  commitment: Uint8Array;
  /** This device's own round-2 share-to-self (contributeThresholdReshare's own return value's `shareToSelf` field). */
  shareToSelf: Uint8Array;
}

export interface JoinThresholdReshareOptions {
  session: Readonly<ThresholdDkgTransport>;
  ownDeviceId: DeviceId;
  /** Every survivor this device must collect a round1 broadcast and round2 share FROM over the wire -- the full survivor set, MINUS this device itself if it is also a survivor (see ownContribution). */
  otherSurvivors: readonly DeviceId[];
  /** Present when this device is itself one of the T survivors (its own contribution is known locally, from a concurrent contributeThresholdReshare call on this same device, never sent to itself over the wire); absent for a brand-new device with no prior share, which only ever receives. */
  ownContribution?: Readonly<ReshareOwnContribution>;
  newParticipants: readonly DeviceId[];
  newThreshold: number;
  existingGroupKey: Uint8Array;
  sessionId: bigint;
  scope?: Readonly<CapabilityScope>;
  token?: CapabilityToken;
  timeoutMs?: number;
}

/**
 * Runs a new-participant's own receiving role: collects every survivor's round1 broadcast and this device's own round2 share, derives the reshared group's public key package (verifying it still matches `existingGroupKey` -- a reshare that changes the group key is a takeover, never adopted), then confirms via the same echo-broadcast digest exchange fresh DKG uses, against every OTHER member of `newParticipants` (not just survivors -- every new-participant peer independently derives and must agree on the identical digest and group key). Rejects, without ever returning a key package, on any digest, group-key, or existing-group-key mismatch.
 */
export async function joinThresholdReshare(
  options: Readonly<JoinThresholdReshareOptions>,
): Promise<ThresholdDkgResult> {
  const verb = keygenCapabilityVerb(true);
  const scope = options.scope ?? THRESHOLD_GROUP_SCOPE;
  const collectors: DkgCollectors = {
    round1: new PerDeviceCollector(),
    round2: new PerDeviceCollector(),
    confirm: new PerDeviceCollector(),
  };
  startDkgConsumeLoop(options.session, verb, options.sessionId, collectors);

  const otherSurvivorEntries: DeviceKeyed[] = await Promise.all(
    options.otherSurvivors.map(async (peer): Promise<DeviceKeyed> => {
      const payload = await collectors.round1.awaitFrom(deviceIdToHex(peer));
      return {
        deviceId: peer,
        value: reshareCombineCommitmentParts(payload.commitment),
      };
    }),
  );
  const survivorEntries: DeviceKeyed[] =
    options.ownContribution !== undefined
      ? [
          {
            deviceId: options.ownDeviceId,
            value: Uint8Array.from(options.ownContribution.commitment),
          },
          ...otherSurvivorEntries,
        ]
      : otherSurvivorEntries;

  const combined = reshareCombineCommitments(
    survivorEntries.map((entry) => entry.value),
  );
  const derived = reshareDerivePublicKeyPackage(
    combined,
    options.newParticipants,
  );
  if (!bytesEqual(derived.groupVerifyingKey, options.existingGroupKey)) {
    throw new Error(
      "reshare's own derived group key does not match existing-group-key -- refusing to adopt a takeover",
    );
  }

  const receivedShares: Uint8Array[] = await Promise.all(
    options.otherSurvivors.map(async (peer) =>
      collectors.round2.awaitFrom(deviceIdToHex(peer)),
    ),
  );
  if (options.ownContribution !== undefined) {
    receivedShares.push(options.ownContribution.shareToSelf);
  }

  const keyPackage = reshareCombineReceivedShares(
    options.ownDeviceId,
    receivedShares,
    derived.publicKeyPackage,
    options.newThreshold,
  );

  const otherNewParticipants = options.newParticipants.filter(
    (peer) => !bytesEqual(peer, options.ownDeviceId),
  );
  const ownDigest = reshareTranscriptDigest(
    survivorEntries,
    derived.groupVerifyingKey,
  );
  await Promise.all(
    otherNewParticipants.map(async (peer) => {
      const command = buildKeygenConfirmCommand(
        options.sessionId,
        ownDigest,
        derived.groupVerifyingKey,
        true,
      );
      await options.session.sendManageRequest(
        command,
        scope,
        peer,
        options.token,
        options.timeoutMs,
      );
    }),
  );
  await Promise.all(
    otherNewParticipants.map(async (peer) => {
      const confirm = await collectors.confirm.awaitFrom(deviceIdToHex(peer));
      const matches = dkgConfirmMatches(
        ownDigest,
        derived.groupVerifyingKey,
        confirm.transcriptDigest,
        confirm.groupKey,
      );
      if (!matches) {
        const error = new Error(
          `reshare echo-broadcast transcript mismatch with ${deviceIdToHex(peer)} -- aborting`,
        );
        collectors.round1.fail(error);
        collectors.round2.fail(error);
        collectors.confirm.fail(error);
        throw error;
      }
    }),
  );

  return {
    keyPackage,
    publicKeyPackage: derived.publicKeyPackage,
    groupVerifyingKey: derived.groupVerifyingKey,
  };
}
