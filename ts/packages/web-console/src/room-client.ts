// Drives core/room over an existing MeshSession -- the console's own client for sending/receiving room and DM messages and handling join/invite admission, kept free of DOM APIs (like webrtc-negotiation.ts beside it) so it is unit-testable against a fake MeshSession. One RoomRouter is constructed per session, mirroring how one WebrtcNegotiator is constructed per session: MeshSession.attach() gives this module a session over an already-negotiated Connection, and from that point this is the one place that speaks core/room on it.

import type {
  CapabilityToken,
  DeviceId,
  ManageCommand,
  RoomMember,
} from "wire-mesh-core/generated/protocol";
import { roomJoinOkSchema } from "wire-mesh-core/generated/protocol";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import {
  mintCapabilityToken,
  type VerifyCapabilityTokenOptions,
} from "wire-mesh-core/domain/tokens";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import {
  ROOM_MEMBER_CAPABILITY,
  verifyRoomToken,
} from "wire-mesh-core/domain/room-token-verification";
import {
  createCapabilityRequestHandler,
  requestCapability,
  type CapabilityGrantDecision,
  type CapabilityGrantRequestEvent,
} from "wire-mesh-core/domain/capability-request";
import {
  createCapabilityGrantHandler,
  sendCapabilityGrant,
  type CapabilityGrantEvent,
} from "wire-mesh-core/domain/capability-grant";

const MESSAGE_ID_BYTE_LENGTH = 16;

function randomMessageId(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(MESSAGE_ID_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytes;
}

const TOKEN_ID_BYTE_LENGTH = 16;

function randomTokenId(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(TOKEN_ID_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** How long an incoming room.join may sit awaiting a human's accept/reject before this side auto-responds with a real manage-error timeout rather than leaving the joiner's own requestToJoin hanging indefinitely -- the same generous, human-approval-window reasoning agent-comms' own PENDING_CONNECTION_TIMEOUT_MINUTES uses for its equivalent connect_request decision. Overridable per RoomRouterOptions.joinRequestTimeoutMs for a caller with its own policy (e.g. a test needing a short window). */
const DEFAULT_JOIN_REQUEST_TIMEOUT_MINUTES = 5;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const DEFAULT_JOIN_REQUEST_TIMEOUT_MS =
  DEFAULT_JOIN_REQUEST_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

export function buildRoomSendCommand(
  text: string,
  messageId: Uint8Array,
  sentAt: number,
): ManageCommand {
  return {
    verb: ROOM_MEMBER_CAPABILITY,
    params: {
      verb: "room.send",
      "message-id": messageId,
      "sent-at": sentAt,
      text,
    },
  };
}

/**
 * Sends a room.send (a DM is just a room-path variant, not a separate verb, so this covers both). token is this side's own room:member grant for roomPath, minted by the room's owner (room.join) or pushed by it (room.invite). targetDevice routes the request via a relay-connect pairing rather than directly over the session's own Connection, the same targetDevice semantics sendManageRequest itself already defines -- omit it for a session that already is the direct connection to the room's other member (web-console's own primary case, one negotiated WebRTC Connection per peer).
 */
export async function sendRoomMessage(
  session: Readonly<MeshSession>,
  roomPath: string,
  text: string,
  token: CapabilityToken,
  targetDevice?: DeviceId,
): Promise<ManageOutcome> {
  const command = buildRoomSendCommand(text, randomMessageId(), Date.now());
  return session.sendManageRequest(
    command,
    { kind: "room", path: roomPath },
    targetDevice,
    token,
  );
}

export interface RoomJoinResult {
  token: CapabilityToken;
  members: DeviceId[];
}

/**
 * Sends the deliberately ungated room.join, now a thin wrapper over capability-request.ts's own generic requestCapability (core/room's room:member grant is the reference specialization of that primitive -- see its own module comment) -- core/room's own design puts access control entirely in the receiving owner's human approval, not a capability check on this request, which is exactly what requestCapability's own ungated ask already provides for any capability. Resolves with the freshly granted token and the room's current member list on approval (parsed back out of the generic grant response's own open extension tail via roomJoinOkSchema); rejects on denial (an ordinary manage-error) or a malformed response.
 */
export async function requestToJoin(
  session: Readonly<MeshSession>,
  roomPath: string,
  targetDevice?: DeviceId,
): Promise<RoomJoinResult> {
  const outcome = await requestCapability(
    session,
    ROOM_MEMBER_CAPABILITY,
    { kind: "room", path: roomPath },
    targetDevice,
  );
  const parsed = roomJoinOkSchema.safeParse(outcome);
  if (!parsed.success) {
    throw new Error(`room.join response for ${roomPath} was malformed`);
  }
  return {
    token: parsed.data["granted-token"],
    members: parsed.data.members.map((member: RoomMember) => member.device),
  };
}

/**
 * Mints a fresh room:member grant for invitee, ready to hand to sendRoomInvite -- the room-specific specialization of the generic mintCapabilityToken, the same way requestToJoin/handleRoomJoin already specialize capability-request.ts's own generic primitives to core/room. There is no equivalent minting call already living in this file to mirror (the accept path's own minting moved into capability-request.ts's createCapabilityRequestHandler when #78 generalized room.join, so room-client.ts itself no longer calls mintCapabilityToken anywhere else): capability-grant is a push of an ALREADY-minted token, so unlike the pull side, minting has to happen here, on the inviter's own side, before there is anything to send at all.
 */
export async function mintRoomInviteGrant(
  identity: Readonly<IdentityPort>,
  clock: Readonly<Clock>,
  roomPath: string,
  invitee: DeviceId,
  expires: number,
  delegationsRemaining?: number,
): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity,
    clock,
    tokenId: randomTokenId(),
    bearer: invitee,
    capability: ROOM_MEMBER_CAPABILITY,
    scope: { kind: "room", path: roomPath },
    expires,
    ...(delegationsRemaining !== undefined ? { delegationsRemaining } : {}),
  });
  if (!verdict.ok) {
    throw new Error(
      `failed to mint an invite grant for ${roomPath} (${verdict.reason})`,
    );
  }
  return verdict.token;
}

/**
 * Sends room.invite, now a thin wrapper over capability-grant.ts's own generic sendCapabilityGrant (core/room's room:member grant is the reference specialization of that primitive, the push counterpart to requestToJoin's own pull-side wrapper over requestCapability) -- core/room's own room.invite is deliberately ungated the same way room.join is: the owner already IS the room's own authority to invite, with no capability check on this request itself, security living entirely in grantedToken's own verification on the receiving end (capability-grant.ts's four obligations). Resolves with the raw manage-response outcome: `{result:"ok"}` once the invitee's own side has validated the pushed token, an ordinary manage-error otherwise -- never a human "no" (an invitee wanting to decline surfaces that as its own room.leave, per agent-comms' existing room.invite/room_invite/decline design, not a wire-level rejection of the push itself).
 */
export async function sendRoomInvite(
  session: Readonly<MeshSession>,
  roomPath: string,
  grantedToken: CapabilityToken,
  targetDevice?: DeviceId,
): Promise<ManageOutcome> {
  return sendCapabilityGrant(
    session,
    ROOM_MEMBER_CAPABILITY,
    grantedToken,
    { kind: "room", path: roomPath },
    targetDevice,
  );
}

export interface IncomingRoomMessage {
  roomPath: string;
  text: string;
  messageId: Uint8Array;
  sentAt: number;
}

export type RoomJoinDecision =
  | {
      kind: "accept";
      capability: string;
      expires: number;
      delegationsRemaining?: number;
    }
  | { kind: "reject"; reason?: string };

export interface RoomJoinRequestEvent {
  roomPath: string;
  requesterDevice: DeviceId;
  /** Resolve this request with the human's decision -- accept mints and returns a fresh room:member grant on the same manage-response (core/room's own room-join-ok shape); reject sends an ordinary manage-error. */
  decide: (decision: Readonly<RoomJoinDecision>) => Promise<void>;
}

export interface RoomInviteEvent {
  roomPath: string;
  /** The peer device-id that pushed this invite -- the room's owner, or whoever else was entrusted to invite on its behalf. */
  granterDevice: DeviceId;
  /** The freshly verified room:member token this invite carried -- already confirmed to independently pass every ordinary token obligation, name this side as its own bearer, and scope-match roomPath (capability-grant.ts's own four obligations). Ready to use exactly as requestToJoin's own RoomJoinResult.token is; there is no decide() here, unlike RoomJoinRequestEvent, since core/room's own room.invite carries no approval round-trip to answer. */
  token: CapabilityToken;
}

export interface RoomRouterOptions extends VerifyCapabilityTokenOptions {
  /** The device-id authenticated as this session's own peer -- MeshSession exposes no way for this module to learn it independently (see webrtc-negotiation.ts's own authorizeIncomingOffer for the same limitation on a pathless scope); the caller already knows this by the time room-client machinery attaches to a session (it just negotiated or accepted the very connection the session runs over). */
  peerDevice: DeviceId;
  /** This room's own current member list, reported back to a joiner on approval (room-join-ok's own members field) -- the caller's own room-membership record, not something this module tracks. Only consulted for an incoming room.join; omit if this router only ever handles room.send. */
  currentMembers?: () => readonly DeviceId[];
  /** Overrides DEFAULT_JOIN_REQUEST_TIMEOUT_MS -- how long an incoming room.join may sit awaiting a human decision before this side auto-responds with a timeout manage-error (capability-request.ts's own receiver-side timeout, wire-mesh#81). */
  joinRequestTimeoutMs?: number;
}

export interface RoomRouterHandlers {
  /** Called for a verified, authorized incoming room.send. */
  onMessage?: (message: Readonly<IncomingRoomMessage>) => void;
  /** Called for an incoming, deliberately ungated room.join, for a human to accept or reject via the given event's own decide(). */
  onJoinRequest?: (event: Readonly<RoomJoinRequestEvent>) => void;
  /** Called for an incoming, verified room.invite -- there is no decision to make (unlike onJoinRequest): by the time this fires, capability-grant.ts's own handler has already responded ok on the wire, so this is purely a notification for the domain to act on (persist the token, surface a UI notice, etc.). Omit for a router that only ever handles room.send/room.join -- an incoming room.invite is then refused with `unsupported_verb`, the same precondition handleRoomJoin already applies to onJoinRequest. */
  onRoomInvite?: (event: Readonly<RoomInviteEvent>) => void;
  /** Called for an incoming room.rekey -- the caller supplies core's createRoomRekeyHandler output (or any handler with the same shape); the router only recognises the verb and forwards the whole incoming request, since the rekey handler answers on the wire itself (ok on successful unwrap, its own specific error codes otherwise). Omit and an incoming room.rekey is left unanswered, this router's default behaviour for any verb it does not recognise. */
  onRekey?: (incoming: Readonly<IncomingManageRequest>) => Promise<void>;
}

/**
 * The one consumer of session.incomingManageRequests for every core/room verb this console speaks, dispatching room.send to onMessage (after verifying the presented token against all six of core/room's obligations -- an unauthorized or malformed request is refused, an ordinary manage-error, and never reaches the caller), room.join to onJoinRequest (deliberately ungated, per core/room's own design: access control lives entirely in the human decision behind decide(), not a token check on the request itself), and room.invite to onRoomInvite (also ungated on the request itself, per the identical reasoning -- security instead lives entirely in the pushed token's own verification against capability-grant.ts's four obligations, with no decision to make once that passes). A single shared consumer, not several independent ones, because concurrent `for await` loops over the same incomingManageRequests would race for its items -- exactly the "shared request router... future work for whenever a second consumer actually exists" gap webrtc-negotiation.ts's own consumeIncoming already flags, now arrived. Runs for the lifetime of the session; a verb this router doesn't recognise is left unanswered rather than misrouted, matching every other domain's own convention in this package.
 */
export function createRoomRouter(
  session: Readonly<MeshSession>,
  options: Readonly<RoomRouterOptions>,
  handlers: Readonly<RoomRouterHandlers>,
): void {
  async function handleRoomSend(
    incoming: Readonly<IncomingManageRequest>,
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const roomPath = incoming.scope.path;
    if (roomPath === undefined || incoming.token === undefined) {
      await incoming.respond({ result: "error", code: "unauthorized" });
      return;
    }
    const verdict = await verifyRoomToken(incoming.token, {
      identity: options.identity,
      clock: options.clock,
      revocation: options.revocation,
      expectedBearer: options.peerDevice,
      roomPath,
    });
    if (!verdict.ok) {
      await incoming.respond({ result: "error", code: "unauthorized" });
      return;
    }
    await incoming.respond({ result: "ok" });
    const messageId = params["message-id"];
    const sentAt = params["sent-at"];
    const text = params.text;
    if (
      !(messageId instanceof Uint8Array) ||
      typeof sentAt !== "number" ||
      typeof text !== "string"
    ) {
      return;
    }
    handlers.onMessage?.({ roomPath, text, messageId, sentAt });
  }

  /**
   * The room-specific adapter between RoomJoinRequestEvent's own decide() (the public shape handlers.onJoinRequest already speaks -- unchanged so no consumer of this router needs to change) and capability-request.ts's generic CapabilityGrantDecision: a reject passes straight through, and an accept computes this room's own member-list extension field (room-join-ok's `members`) before handing off to the generic event's own decide(), which does the actual minting and responding.
   */
  function adaptRoomJoinDecision(
    event: Readonly<CapabilityGrantRequestEvent>,
  ): (decision: Readonly<RoomJoinDecision>) => Promise<void> {
    return async (decision: Readonly<RoomJoinDecision>): Promise<void> => {
      if (decision.kind === "reject") {
        const generic: CapabilityGrantDecision = {
          kind: "reject",
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        };
        await event.decide(generic);
        return;
      }
      const members = [
        ...(options.currentMembers?.() ?? []),
        options.peerDevice,
      ].map((device) => ({ device }));
      const generic: CapabilityGrantDecision = {
        kind: "accept",
        capability: decision.capability,
        expires: decision.expires,
        ...(decision.delegationsRemaining !== undefined
          ? { delegationsRemaining: decision.delegationsRemaining }
          : {}),
        extensions: { members },
      };
      await event.decide(generic);
    };
  }

  const handleCapabilityGrantRequest = createCapabilityRequestHandler({
    capability: ROOM_MEMBER_CAPABILITY,
    identity: options.identity,
    clock: options.clock,
    bearerDevice: options.peerDevice,
    timeoutMs: options.joinRequestTimeoutMs ?? DEFAULT_JOIN_REQUEST_TIMEOUT_MS,
    onRequest(event: Readonly<CapabilityGrantRequestEvent>): void {
      const roomPath = event.scope.path;
      const onJoinRequest = handlers.onJoinRequest;
      // Both unreachable in practice -- handleRoomJoin below already refuses (missing_scope_path/unsupported_verb, matching this router's own pre-rewiring codes exactly) before ever calling this handler when either precondition fails. Kept because CapabilityGrantRequestEvent's own scope/handlers types don't encode either precondition structurally, so TS cannot narrow across this callback boundary on its own.
      if (roomPath === undefined || onJoinRequest === undefined) {
        void event.decide({ kind: "reject", reason: "unsupported verb" });
        return;
      }
      onJoinRequest({
        roomPath,
        requesterDevice: event.requesterDevice,
        decide: adaptRoomJoinDecision(event),
      });
    },
  });

  async function handleRoomJoin(
    incoming: Readonly<IncomingManageRequest>,
  ): Promise<void> {
    const roomPath = incoming.scope.path;
    if (roomPath === undefined) {
      await incoming.respond({ result: "error", code: "missing_scope_path" });
      return;
    }
    if (handlers.onJoinRequest === undefined) {
      await incoming.respond({ result: "error", code: "unsupported_verb" });
      return;
    }
    await handleCapabilityGrantRequest(incoming);
  }

  const handleCapabilityGrant = createCapabilityGrantHandler({
    capability: ROOM_MEMBER_CAPABILITY,
    identity: options.identity,
    clock: options.clock,
    revocation: options.revocation,
    granterDevice: options.peerDevice,
    onGrant(event: Readonly<CapabilityGrantEvent>): void {
      const roomPath = event.scope.path;
      const onRoomInvite = handlers.onRoomInvite;
      // Both unreachable in practice -- handleRoomInvite below already refuses (missing_scope_path/unsupported_verb, matching this router's own pre-rewiring codes exactly) before ever calling this handler when either precondition fails. Kept because CapabilityGrantEvent's own scope/handlers types don't encode either precondition structurally, so TS cannot narrow across this callback boundary on its own -- the same reasoning adaptRoomJoinDecision's own onRequest callback above already documents for the identical shape of guard.
      if (roomPath === undefined || onRoomInvite === undefined) {
        return;
      }
      onRoomInvite({
        roomPath,
        granterDevice: event.granterDevice,
        token: event.grantedToken,
      });
    },
  });

  async function handleRoomInvite(
    incoming: Readonly<IncomingManageRequest>,
  ): Promise<void> {
    const roomPath = incoming.scope.path;
    if (roomPath === undefined) {
      await incoming.respond({ result: "error", code: "missing_scope_path" });
      return;
    }
    if (handlers.onRoomInvite === undefined) {
      await incoming.respond({ result: "error", code: "unsupported_verb" });
      return;
    }
    await handleCapabilityGrant(incoming);
  }

  void (async () => {
    for await (const incoming of session.incomingManageRequests) {
      if (incoming.command.verb !== ROOM_MEMBER_CAPABILITY) {
        continue;
      }
      const params = incoming.command.params;
      if (typeof params !== "object" || !("verb" in params)) {
        continue;
      }
      if (params.verb === "room.send") {
        await handleRoomSend(incoming, params);
      } else if (params.verb === "capability.request") {
        await handleRoomJoin(incoming);
      } else if (params.verb === "capability.grant") {
        await handleRoomInvite(incoming);
      } else if (
        params.verb === "room.rekey" &&
        handlers.onRekey !== undefined
      ) {
        await handlers.onRekey(incoming);
      }
    }
  })();
}
