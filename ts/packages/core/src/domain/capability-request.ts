/**
 * The generic, capability-agnostic capability-request / capability-grant-ok primitive (wire-mesh#78, spec/management.cddl). Lifts core/room's own room.join shape -- an ungated ask, held open, a human (or any other domain-supplied decision) accepts or refuses, acceptance mints and returns a token on the same response -- out of that one domain so any capability can reuse it, not just room:member. core/room's own room-client.ts is the reference consumer: it rewires requestToJoin/createRoomRouter's room.join handling onto requestCapability/createCapabilityRequestHandler below, supplying room-specific extension fields (its member list) through this module's own extensions mechanism rather than this module knowing anything about rooms.
 *
 * Two responsibilities live here, split the same way tokens.ts and room-token-verification.ts already split verification concerns: requestCapability is the asking side (a thin wrapper over MeshSession.sendManageRequest, parsing the grant response), and createCapabilityRequestHandler is the receiving side (validates the incoming ask, arms a receiver-side timeout so an unanswered request never hangs a requester forever, and hands the decision to the domain).
 */

import {
  capabilityGrantOkSchema,
  capabilityRequestSchema,
  type CapabilityGrantOk,
  type CapabilityScope,
  type CapabilityToken,
  type DeviceId,
  type ManageCommand,
} from "../generated/protocol.js";
import type {
  IncomingManageRequest,
  MeshSession,
} from "./mesh-session.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityPort } from "../ports/identity.js";
import { mintCapabilityToken } from "./tokens.js";

const TOKEN_ID_BYTE_LENGTH = 16;

function randomTokenId(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(TOKEN_ID_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Builds a capability-request command per management.cddl. The outer `manage-command.verb` is the capability string itself -- the same value as this map's own `params.capability` field -- never a generic literal: capability-verb's own CDDL grammar is a closed alternation of colon-delimited `domain:noun` regexes (spec/tokens.cddl), so a bare literal like "capability" could never satisfy it, and routing by capability (the same way room.send/room.join already share the ROOM_MEMBER_CAPABILITY outer verb) is how a receiver's own per-capability handler knows which grant this ask is even for. `params.verb` is the fixed "capability.request" marker that distinguishes this ask from any other verb sharing the same outer capability (mirroring room.send/room.join's own inner `params.verb` split under one shared outer verb). `valid-until`, when given, bounds how long this ask is worth granting (wire-mesh#82) -- a receiver refuses outright once its own clock has passed it, rather than presenting a stale ask to a human for approval.
 */
export function buildCapabilityRequestCommand(
  capability: string,
  validUntil?: number,
): ManageCommand {
  return {
    verb: capability,
    params: {
      verb: "capability.request",
      capability,
      ...(validUntil !== undefined ? { "valid-until": validUntil } : {}),
    },
  };
}

/**
 * Sends a deliberately ungated capability-request (no token field at all -- per management.cddl's own header comment, this primitive puts access control entirely in the receiving side's own decision, not a capability check on the request itself, the same design room.join already established). Resolves with the freshly granted capability-grant-ok on approval (its own open `* tstr => any` tail may carry domain-specific extension fields, e.g. core/room's member list -- a caller that needs those parses the raw result itself, the same way room-client.ts's own requestToJoin wrapper does); rejects on denial (an ordinary manage-error) or a malformed response.
 *
 * targetDevice and timeoutMs forward directly to MeshSession.sendManageRequest's own identically-named parameters (relay routing and a requester-side give-up bound respectively -- wire-mesh#80 is already implemented there, not duplicated here). validUntil, when given, is attached to the request itself (wire-mesh#82) so a slow-to-answer receiver -- or a relay/facilitator forwarding this request on the caller's behalf -- can refuse or drop a now-stale ask outright rather than holding or forwarding it.
 */
export async function requestCapability(
  session: Readonly<MeshSession>,
  capability: string,
  scope: Readonly<CapabilityScope>,
  targetDevice?: DeviceId,
  timeoutMs?: number,
  validUntil?: number,
): Promise<CapabilityGrantOk> {
  const outcome = await session.sendManageRequest(
    buildCapabilityRequestCommand(capability, validUntil),
    scope,
    targetDevice,
    undefined,
    timeoutMs,
  );
  if (outcome.result !== "ok") {
    throw new Error(
      `capability request for "${capability}" was refused (${outcome.code})`,
    );
  }
  const parsed = capabilityGrantOkSchema.safeParse(outcome);
  if (!parsed.success) {
    throw new Error(
      `capability request for "${capability}" response was malformed`,
    );
  }
  return parsed.data;
}

/**
 * A receiver's decision on one incoming capability-request, mirroring room-client.ts's own (now capability-specific) RoomJoinDecision, generalized to any capability: "accept" mints and returns a fresh token; "reject" sends an ordinary manage-error carrying an optional human-readable reason.
 */
export type CapabilityGrantDecision =
  | {
      kind: "accept";
      /** The capability the minted token actually carries -- usually, but not necessarily, the same string the request itself asked for (a receiver is free to grant something narrower). */
      capability: string;
      expires: number;
      delegationsRemaining?: number;
      /** Fields the domain wants merged onto the `{result:"ok", "granted-token": token, ...}` response, riding capability-grant-ok's own open `* tstr => any` tail -- the mechanism core/room's own room-join-ok uses for its `members` field, generalized so this module never needs to know what any particular capability's own grant response should additionally carry. Omit for a capability (e.g. a bare exec grant) whose response needs nothing beyond the token itself. */
      extensions?: Record<string, unknown>;
    }
  | { kind: "reject"; reason?: string };

/** One incoming, not-yet-expired capability-request, surfaced for the domain to accept or reject via decide(). */
export interface CapabilityGrantRequestEvent {
  /** The scope this request's own manage-request-frame carries -- e.g. core/room's `{kind:"room", path: roomPath}` -- passed through unchanged so the domain can inspect it (a room handler reads `.path` back out) without this module needing to know its shape. */
  scope: Readonly<CapabilityScope>;
  /** The peer device-id authenticated on the connection this request arrived over -- the requester, and so the future bearer of any token minted on acceptance. Same role as RoomRouterOptions.peerDevice / RoomJoinRequestEvent.requesterDevice. */
  requesterDevice: DeviceId;
  /** Resolves this request with the domain's decision. Settles the request's response exactly once: whichever of a real decide() call or the handler's own receiver-side timeout comes first wins, and the other is a no-op -- the same single-settle guarantee agent-comms' own PendingConnection timer/accept/reject/disconnect race already established (ported here, not reinvented). */
  decide: (decision: Readonly<CapabilityGrantDecision>) => Promise<void>;
}

export interface CreateCapabilityRequestHandlerOptions {
  /** The capability this handler grants. Checked against both the incoming request's own `params.capability` field (a mismatch is refused as malformed rather than trusted -- nothing about manage-command.verb structurally guarantees params.capability agrees with it) and used as the scope this handler is willing to act on at all; a caller wanting to grant several distinct capabilities over one session constructs one handler per capability, the same way core/room constructs one handler for `room:member` and nothing else. */
  capability: string;
  identity: IdentityPort;
  clock: Clock;
  /** The peer device-id authenticated on this session's own connection -- the requester, and so the future bearer of any token this handler mints. One handler is constructed per session for the same reason one RoomRouter is (RoomRouterOptions.peerDevice): MeshSession exposes no way for domain code to learn the authenticated peer independently. */
  bearerDevice: DeviceId;
  /** Receiver-side auto-reject window (wire-mesh#81): how long an incoming request may sit awaiting the domain's decision before this side responds with a real manage-error timeout rather than leaving the requester's own sendManageRequest hanging indefinitely. Ported from agent-comms' PendingConnection pattern (`wire-mesh-transport.ts`'s `pendingConnectionTimeoutMs` / `expirePendingConnection`): an unref'd timer so a stray one can never by itself keep the process alive, cleared the instant decide() is actually called so it can never fire after the request has already been answered. IncomingManageRequest exposes no requester-disconnect signal at this layer (unlike agent-comms' own transport, which owns the raw connection), so only the timeout half of that pattern is implemented here -- there is nothing to detect the requester giving up early honestly, so this module does not pretend to. */
  timeoutMs: number;
  /** Called once per incoming, not-yet-expired capability-request, for the domain to accept or reject via the event's own decide(). */
  onRequest: (event: Readonly<CapabilityGrantRequestEvent>) => void;
}

/**
 * Builds a reusable handler for one capability's incoming capability-requests. The returned function is the generic counterpart to room-client.ts's own (now capability-specific) handleRoomJoin: given one IncomingManageRequest, it refuses a request for the wrong capability or a malformed payload as `{result:"error", code:"malformed"}`, refuses an already-expired request (per its own `valid-until`, wire-mesh#82) as `{result:"error", code:"expired"}` without ever invoking onRequest, otherwise arms the receiver-side timeout described on CreateCapabilityRequestHandlerOptions.timeoutMs and calls onRequest so the domain can accept (minting a fresh token via mintCapabilityToken and responding `{result:"ok", "granted-token": token, ...extensions}`) or reject (an ordinary manage-error) via the event's own decide().
 */
export function createCapabilityRequestHandler(
  options: Readonly<CreateCapabilityRequestHandlerOptions>,
): (incoming: Readonly<IncomingManageRequest>) => Promise<void> {
  return async function handleCapabilityRequest(
    incoming: Readonly<IncomingManageRequest>,
  ): Promise<void> {
    const parsed = capabilityRequestSchema.safeParse(incoming.command.params);
    if (!parsed.success || parsed.data.capability !== options.capability) {
      await incoming.respond({ result: "error", code: "malformed" });
      return;
    }
    const params = parsed.data;
    const validUntil = params["valid-until"];
    if (validUntil !== undefined && validUntil <= options.clock.now()) {
      await incoming.respond({ result: "error", code: "expired" });
      return;
    }

    // Settles exactly once: whichever of the timeout below or a real decide() call happens first wins, and clears/no-ops the other -- see CreateCapabilityRequestHandlerOptions.timeoutMs.
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      void incoming
        .respond({
          result: "error",
          code: "timeout",
          message: "no decision within the capability-request timeout",
        })
        .catch(() => undefined);
    }, options.timeoutMs);
    timeoutHandle.unref();

    options.onRequest({
      scope: incoming.scope,
      requesterDevice: options.bearerDevice,
      async decide(decision: Readonly<CapabilityGrantDecision>): Promise<void> {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (decision.kind === "reject") {
          await incoming.respond({
            result: "error",
            code: "denied",
            ...(decision.reason !== undefined
              ? { message: decision.reason }
              : {}),
          });
          return;
        }
        const verdict = await mintCapabilityToken({
          identity: options.identity,
          clock: options.clock,
          tokenId: randomTokenId(),
          bearer: options.bearerDevice,
          capability: decision.capability,
          scope: incoming.scope,
          expires: decision.expires,
          ...(decision.delegationsRemaining !== undefined
            ? { delegationsRemaining: decision.delegationsRemaining }
            : {}),
        });
        if (!verdict.ok) {
          await incoming.respond({ result: "error", code: "mint_failed" });
          return;
        }
        const grantedToken: CapabilityToken = verdict.token;
        await incoming.respond({
          result: "ok",
          "granted-token": grantedToken,
          ...(decision.extensions ?? {}),
        });
      },
    });
  };
}
