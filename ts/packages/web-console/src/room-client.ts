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
import type { VerifyCapabilityTokenOptions } from "wire-mesh-core/domain/tokens";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import {
  ROOM_MEMBER_CAPABILITY,
  verifyRoomToken,
} from "wire-mesh-core/domain/room-token-verification";

const MESSAGE_ID_BYTE_LENGTH = 16;

function randomMessageId(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(MESSAGE_ID_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytes;
}

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

export function buildRoomJoinCommand(): ManageCommand {
  return { verb: ROOM_MEMBER_CAPABILITY, params: { verb: "room.join" } };
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
 * Sends the deliberately ungated room.join (no token field at all -- core/room's own design puts access control entirely in the receiving owner's human approval, not a capability check on this request). Resolves with the freshly granted token and the room's current member list on approval; rejects on denial (an ordinary manage-error) or a malformed response.
 */
export async function requestToJoin(
  session: Readonly<MeshSession>,
  roomPath: string,
  targetDevice?: DeviceId,
): Promise<RoomJoinResult> {
  const outcome = await session.sendManageRequest(
    buildRoomJoinCommand(),
    { kind: "room", path: roomPath },
    targetDevice,
  );
  if (outcome.result !== "ok") {
    throw new Error(`room.join for ${roomPath} was refused (${outcome.code})`);
  }
  const parsed = roomJoinOkSchema.safeParse(outcome);
  if (!parsed.success) {
    throw new Error(`room.join response for ${roomPath} was malformed`);
  }
  return {
    token: parsed.data["granted-token"],
    members: parsed.data.members.map((member: RoomMember) => member.device),
  };
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

export interface RoomRouterOptions extends VerifyCapabilityTokenOptions {
  /** The device-id authenticated as this session's own peer -- MeshSession exposes no way for this module to learn it independently (see webrtc-negotiation.ts's own authorizeIncomingOffer for the same limitation on a pathless scope); the caller already knows this by the time room-client machinery attaches to a session (it just negotiated or accepted the very connection the session runs over). */
  peerDevice: DeviceId;
  /** This room's own current member list, reported back to a joiner on approval (room-join-ok's own members field) -- the caller's own room-membership record, not something this module tracks. Only consulted for an incoming room.join; omit if this router only ever handles room.send. */
  currentMembers?: () => readonly DeviceId[];
}

export interface RoomRouterHandlers {
  /** Called for a verified, authorized incoming room.send. */
  onMessage?: (message: Readonly<IncomingRoomMessage>) => void;
  /** Called for an incoming, deliberately ungated room.join, for a human to accept or reject via the given event's own decide(). */
  onJoinRequest?: (event: Readonly<RoomJoinRequestEvent>) => void;
}

/**
 * The one consumer of session.incomingManageRequests for every core/room verb this console speaks, dispatching room.send to onMessage (after verifying the presented token against all six of core/room's obligations -- an unauthorized or malformed request is refused, an ordinary manage-error, and never reaches the caller) and room.join to onJoinRequest (deliberately ungated, per core/room's own design: access control lives entirely in the human decision behind decide(), not a token check on the request itself). A single shared consumer, not two independent ones, because two concurrent `for await` loops over the same incomingManageRequests would race for its items -- exactly the "shared request router... future work for whenever a second consumer actually exists" gap webrtc-negotiation.ts's own consumeIncoming already flags, now arrived. Runs for the lifetime of the session; a verb this router doesn't recognise is left unanswered rather than misrouted, matching every other domain's own convention in this package.
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
    handlers.onJoinRequest({
      roomPath,
      requesterDevice: options.peerDevice,
      async decide(decision: Readonly<RoomJoinDecision>): Promise<void> {
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
          tokenId: randomMessageId(),
          bearer: options.peerDevice,
          capability: decision.capability,
          scope: { kind: "room", path: roomPath },
          expires: decision.expires,
          ...(decision.delegationsRemaining !== undefined
            ? { delegationsRemaining: decision.delegationsRemaining }
            : {}),
        });
        if (!verdict.ok) {
          await incoming.respond({ result: "error", code: "mint_failed" });
          return;
        }
        const members = [
          ...(options.currentMembers?.() ?? []),
          options.peerDevice,
        ].map((device) => ({ device }));
        await incoming.respond({
          result: "ok",
          "granted-token": verdict.token,
          members,
        });
      },
    });
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
      } else if (params.verb === "room.join") {
        await handleRoomJoin(incoming);
      }
    }
  })();
}
