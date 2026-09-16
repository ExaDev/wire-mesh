/**
 * room.rekey (wire-mesh#141, spec/room.cddl): distributes and rotates a room's symmetric content-encryption key. Two responsibilities, split the same way capability-grant.ts and capability-request.ts already split theirs: sendRoomRekey is the pushing side (a thin wrapper over MeshSession.sendManageRequest), and createRoomRekeyHandler is the receiving side.
 *
 * The receiving side's own security property is worth stating plainly, since it's what makes this handler simpler than it might look: it needs no separate check of who actually sent the request. verifyRoomToken (obligation 1) already certifies that the recipient's OWN held room:member token's delegation chain terminates at the room's real, rightful owner -- deriving the ECDH shared secret against that certified owner's own rootIssuerKey means a wrapped-key only ever unwraps correctly when it was actually produced by someone holding the real owner's private key. A forged room.rekey from anyone else -- an attacker, a not-yet-admitted stranger, even another legitimate member with no admission authority -- cannot produce ciphertext that unwraps, so it fails closed on the cryptography itself rather than needing a redundant, separately-maintained live-sender identity check.
 */

import {
  roomRekeySchema,
  type CapabilityScope,
  type CapabilityToken,
  type DeviceId,
  type ManageCommand,
} from "../generated/protocol.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "./mesh-session.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityPort } from "../ports/identity.js";
import {
  ROOM_MEMBER_CAPABILITY,
  verifyRoomToken,
} from "./room-token-verification.js";
import { deriveWrappingKey, unwrapContentKey } from "./group-key.js";
import type { RevocationCheck } from "./tokens.js";

/**
 * Builds a room.rekey command per room.cddl. The outer verb is room:member, the same "one resource, several inner verbs" pattern room.send/room.leave/room.members already establish -- not a new capability of its own.
 */
export function buildRoomRekeyCommand(
  keyEpoch: number,
  wrappedKey: Uint8Array | readonly Uint8Array[],
): ManageCommand {
  return {
    verb: ROOM_MEMBER_CAPABILITY,
    params: {
      verb: "room.rekey",
      "key-epoch": keyEpoch,
      "wrapped-key": wrappedKey,
    },
  };
}

/** Sends a room.rekey for roomPath. targetDevice/token forward directly to MeshSession.sendManageRequest's own identically-named parameters, exactly as sendRoomMessage's own doc comment already describes. */
export async function sendRoomRekey(
  session: Readonly<MeshSession>,
  roomPath: string,
  keyEpoch: number,
  wrappedKey: Uint8Array | readonly Uint8Array[],
  targetDevice?: DeviceId,
  token?: CapabilityToken,
): Promise<ManageOutcome> {
  return session.sendManageRequest(
    buildRoomRekeyCommand(keyEpoch, wrappedKey),
    { kind: "room", path: roomPath } satisfies CapabilityScope,
    targetDevice,
    token,
  );
}

/** One incoming, fully-verified and unwrapped room.rekey, surfaced for the domain to store (index content keys by epoch for later room-notice decryption). */
export interface RoomRekeyEvent {
  room: string;
  /** The highest epoch this room.rekey granted -- the same value the wire message itself carried. */
  keyEpoch: number;
  /** contentKeys[i] is the content-encryption key for epoch i+1, matching wrapped-key's own array-ordering convention (spec/room.cddl) -- always at least one entry (the current epoch), even under the default single-bstr, members-at-the-time policy. */
  contentKeys: readonly Uint8Array[];
}

export interface CreateRoomRekeyHandlerOptions {
  /** This recipient's own identity -- both the verification primitives ownRoomMemberToken is checked with, and (via deriveSharedSecret) the ECDH half of unwrapping. */
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationCheck;
  /** This recipient's own currently-held room:member token for the room being rekeyed, verified fresh on every incoming room.rekey (not cached) -- see this module's own doc comment for why its certified root issuer-key is what the ECDH derivation uses, rather than a separately-tracked live-sender identity. */
  ownRoomMemberToken: CapabilityToken;
  /** Called once per successfully unwrapped room.rekey. */
  onRekey: (event: Readonly<RoomRekeyEvent>) => void;
}

/**
 * Builds a reusable handler for one room's incoming room.rekey messages. Checks, in order: the outer verb is room:member (otherwise "malformed"); the params payload parses against room.rekey's own CDDL shape (otherwise "malformed"); the request's own scope is a room scope (otherwise "scope_mismatch"); ownRoomMemberToken independently passes every one of core/room's six verifier obligations, scoped to the incoming request's own room path (a failure responds with verifyRoomToken's own specific reason, e.g. "wrong_chain_root"/"wrong_scope_path"/"expired"); this identity actually supports deriveSharedSecret (otherwise "ecdh_unsupported" -- an Ed25519-only identity genuinely cannot participate). Only then does it derive the shared secret against the verified chain's own rootIssuerKey, derive one wrapping key per granted epoch (per the array-ordering convention: entry i is epoch i+1, counting back from key-epoch), and unwrap each -- a failure at that final cryptographic step (a forged sender, or genuine corruption) responds "unwrap_failed" rather than surfacing a partially-decoded result.
 */
export function createRoomRekeyHandler(
  options: Readonly<CreateRoomRekeyHandlerOptions>,
): (incoming: Readonly<IncomingManageRequest>) => Promise<void> {
  return async function handleRoomRekey(
    incoming: Readonly<IncomingManageRequest>,
  ): Promise<void> {
    if (incoming.command.verb !== ROOM_MEMBER_CAPABILITY) {
      await incoming.respond({ result: "error", code: "malformed" });
      return;
    }
    const parsed = roomRekeySchema.safeParse(incoming.command.params);
    if (!parsed.success) {
      await incoming.respond({ result: "error", code: "malformed" });
      return;
    }
    if (incoming.scope.kind !== "room" || incoming.scope.path === undefined) {
      await incoming.respond({ result: "error", code: "scope_mismatch" });
      return;
    }
    const roomPath = incoming.scope.path;

    const verdict = await verifyRoomToken(options.ownRoomMemberToken, {
      identity: options.identity,
      clock: options.clock,
      revocation: options.revocation,
      expectedBearer: options.identity.deviceId,
      roomPath,
    });
    if (!verdict.ok) {
      await incoming.respond({ result: "error", code: verdict.reason });
      return;
    }

    const deriveSharedSecret = options.identity.deriveSharedSecret;
    if (deriveSharedSecret === undefined) {
      await incoming.respond({ result: "error", code: "ecdh_unsupported" });
      return;
    }

    const keyEpoch = parsed.data["key-epoch"];
    const wrappedKeys = Array.isArray(parsed.data["wrapped-key"])
      ? parsed.data["wrapped-key"]
      : [parsed.data["wrapped-key"]];
    const firstEpoch = keyEpoch - wrappedKeys.length + 1;

    let contentKeys: Uint8Array[];
    try {
      const sharedSecret = await deriveSharedSecret(verdict.rootIssuerKey);
      contentKeys = await Promise.all(
        wrappedKeys.map(async (wrapped, i) => {
          const wrappingKey = await deriveWrappingKey(sharedSecret, {
            room: roomPath,
            keyEpoch: firstEpoch + i,
          });
          return unwrapContentKey(wrappingKey, wrapped);
        }),
      );
    } catch {
      await incoming.respond({ result: "error", code: "unwrap_failed" });
      return;
    }

    await incoming.respond({ result: "ok" });
    options.onRekey({ room: roomPath, keyEpoch, contentKeys });
  };
}
