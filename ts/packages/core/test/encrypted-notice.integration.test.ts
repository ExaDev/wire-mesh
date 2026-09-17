import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import { mintCapabilityToken } from "../src/domain/tokens.js";
import { createRevocationView } from "../src/domain/revocation-view.js";
import { ownerNamedRoomPath } from "../src/domain/room-path.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import {
  decryptNoticeContent,
  deriveWrappingKey,
  encryptNoticeContent,
  encryptedContentType,
  generateContentKey,
  plaintextContentType,
  wrapContentKey,
} from "../src/domain/group-key.js";
import {
  buildRoomRekeyCommand,
  createRoomRekeyHandler,
  type RoomRekeyEvent,
} from "../src/domain/room-rekey.js";
import { createRoomNotice, verifyRoomNotice } from "../src/domain/room.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { Clock } from "../src/ports/clock.js";
import type {
  CapabilityScope,
  CapabilityToken,
  ManageCommand,
} from "../src/generated/protocol.js";
import type { IncomingManageRequest } from "../src/domain/mesh-session.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;
const NOW_MS = 1_893_456_000_000;
const EXPIRES_MS = NOW_MS + HOUR_MS;
const FIRST_EPOCH = 1;
const SECOND_EPOCH = 2;
const FIRST_NOTICE_ID = 0xa3;
const SECOND_NOTICE_ID = 0xa4;
const THIRD_NOTICE_ID = 0xa5;

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

/** Generates an ES256 identity wired for deriveSharedSecret -- the same caller-side dual-import technique node-identity.test.ts documents. */
async function generateEs256Identity(): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const privateJwk = await webcrypto.subtle.exportKey(
    "jwk",
    keyPair.privateKey,
  );
  const ecdhJwk: JsonWebKey = { ...privateJwk, key_ops: ["deriveBits"] };
  delete ecdhJwk.alg;
  const ecdhPrivateKey = await webcrypto.subtle.importKey(
    "jwk",
    ecdhJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return createNodeIdentity(
    keyPair.privateKey,
    publicKeyBytes,
    ES256,
    ecdhPrivateKey,
  );
}

async function deriveSharedSecretOrThrow(
  identity: IdentityPort,
  peer: IdentityPort,
): Promise<Uint8Array> {
  if (identity.deriveSharedSecret === undefined) {
    throw new Error("identity must expose deriveSharedSecret");
  }
  return identity.deriveSharedSecret(peer.identityKey);
}

/** The room owner's rekey-sending half: generates a fresh epoch key, wraps it for one recipient, and returns both the wire command and the owner's own retained copy of the key (the owner needs it to decrypt members' notices later -- it holds every epoch's key by construction, being the rekey sender). */
async function ownerRekeys(
  owner: IdentityPort,
  recipient: IdentityPort,
  roomPath: string,
  keyEpoch: number,
): Promise<{ command: ManageCommand; ownerKeyCopy: Uint8Array }> {
  const contentKey = generateContentKey();
  const sharedSecret = await deriveSharedSecretOrThrow(owner, recipient);
  const wrappingKey = await deriveWrappingKey(sharedSecret, {
    room: roomPath,
    keyEpoch,
  });
  const wrapped = await wrapContentKey(wrappingKey, contentKey);
  return {
    command: buildRoomRekeyCommand(keyEpoch, wrapped),
    ownerKeyCopy: contentKey,
  };
}

function deliver(
  command: ManageCommand,
  scope: Readonly<CapabilityScope>,
): IncomingManageRequest {
  return {
    requestId: 0,
    command,
    scope,
    respond: vi.fn(async (): Promise<void> => Promise.resolve()),
  };
}

async function mintRoomMemberToken(
  issuer: IdentityPort,
  bearer: IdentityPort,
  roomPath: string,
): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock: fixedClock(NOW_MS),
    tokenId: Uint8Array.from([1]),
    bearer: bearer.deviceId,
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: EXPIRES_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);
  return verdict.token;
}

describe("encrypted room-notice end to end", () => {
  it("rekey, encrypted post, verification, and decryption all compose", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const memberToken = await mintRoomMemberToken(owner, member, roomPath);

    // Owner rekeys the room for the member.
    const { command, ownerKeyCopy } = await ownerRekeys(
      owner,
      member,
      roomPath,
      FIRST_EPOCH,
    );
    const memberKeys = new Map<number, Uint8Array>();
    const handler = createRoomRekeyHandler({
      identity: member,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: memberToken,
      onRekey: (event: Readonly<RoomRekeyEvent>) => {
        event.contentKeys.forEach((key, i) => {
          memberKeys.set(
            event.keyEpoch - event.contentKeys.length + 1 + i,
            key,
          );
        });
      },
    });
    await handler(deliver(command, { kind: "room", path: roomPath }));
    expect(memberKeys.get(FIRST_EPOCH)).toEqual(ownerKeyCopy);

    // Member posts an encrypted notice under epoch 1.
    const plaintext = new TextEncoder().encode("see you at the usual spot");
    const ciphertext = await encryptNoticeContent(
      memberKeys.get(FIRST_EPOCH) ?? new Uint8Array(0),
      plaintext,
    );
    const notice = await createRoomNotice({
      identity: member,
      clock: fixedClock(NOW_MS),
      room: roomPath,
      token: memberToken,
      noticeId: Uint8Array.from([FIRST_NOTICE_ID]),
      contentType: encryptedContentType("text/plain"),
      content: ciphertext,
      keyEpoch: FIRST_EPOCH,
    });

    // A reader verifies the notice (all obligations incl. 7's pairing)...
    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedRoom: roomPath,
    });
    if (!verdict.ok) throw new Error(`unexpected: ${verdict.reason}`);
    expect(verdict.claims["key-epoch"]).toBe(FIRST_EPOCH);

    // ...then decrypts with the epoch key from its own rekey store.
    const decrypted = await decryptNoticeContent(
      ownerKeyCopy,
      verdict.claims.content,
    );
    expect(decrypted).toEqual(plaintext);
    expect(plaintextContentType(verdict.claims["content-type"])).toBe(
      "text/plain",
    );
  });

  it("a reader without the epoch key still verifies the notice but cannot decrypt -- the confidentiality property itself", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const outsider = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const memberToken = await mintRoomMemberToken(owner, member, roomPath);
    const { command, ownerKeyCopy } = await ownerRekeys(
      owner,
      member,
      roomPath,
      FIRST_EPOCH,
    );
    const memberKeys = new Map<number, Uint8Array>();
    const handler = createRoomRekeyHandler({
      identity: member,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: memberToken,
      onRekey: (event: Readonly<RoomRekeyEvent>) => {
        memberKeys.set(
          event.keyEpoch,
          event.contentKeys[0] ?? new Uint8Array(0),
        );
      },
    });
    await handler(deliver(command, { kind: "room", path: roomPath }));

    const plaintext = new TextEncoder().encode("secret");
    const ciphertext = await encryptNoticeContent(
      memberKeys.get(FIRST_EPOCH) ?? new Uint8Array(0),
      plaintext,
    );
    const notice = await createRoomNotice({
      identity: member,
      clock: fixedClock(NOW_MS),
      room: roomPath,
      token: memberToken,
      noticeId: Uint8Array.from([SECOND_NOTICE_ID]),
      contentType: encryptedContentType("text/plain"),
      content: ciphertext,
      keyEpoch: FIRST_EPOCH,
    });

    // The outsider (never rekeyed, holds no epoch key) verifies every obligation fine -- read-confidentiality is about content, not authenticity -- but its decryption attempt fails closed.
    const verdict = await verifyRoomNotice(notice, {
      identity: outsider,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });
    expect(verdict.ok).toBe(true);

    const randomWrongKey = generateContentKey();
    await expect(
      decryptNoticeContent(randomWrongKey, ciphertext),
    ).rejects.toThrow();
    // Sanity on the test's own premise: the owner's real copy does decrypt.
    expect(await decryptNoticeContent(ownerKeyCopy, ciphertext)).toEqual(
      plaintext,
    );
  });

  it("rotation holds: a member rekeyed to epoch 2 reads epoch-2 notices, while a member stuck on epoch 1 cannot", async () => {
    const owner = await generateEs256Identity();
    const stayingMember = await generateEs256Identity();
    const kickedMember = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const stayingToken = await mintRoomMemberToken(
      owner,
      stayingMember,
      roomPath,
    );
    const kickedToken = await mintRoomMemberToken(
      owner,
      kickedMember,
      roomPath,
    );

    // Epoch 1: both members are rekeyed.
    const epoch1 = await ownerRekeys(
      owner,
      stayingMember,
      roomPath,
      FIRST_EPOCH,
    );
    const epoch1Kicked = await ownerRekeys(
      owner,
      kickedMember,
      roomPath,
      FIRST_EPOCH,
    );
    const stayingKeys = new Map<number, Uint8Array>();
    const stayingHandler = createRoomRekeyHandler({
      identity: stayingMember,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: stayingToken,
      onRekey: (event: Readonly<RoomRekeyEvent>) => {
        stayingKeys.set(
          event.keyEpoch,
          event.contentKeys[0] ?? new Uint8Array(0),
        );
      },
    });
    await stayingHandler(
      deliver(epoch1.command, { kind: "room", path: roomPath }),
    );
    const kickedKeys = new Map<number, Uint8Array>();
    const kickedHandler = createRoomRekeyHandler({
      identity: kickedMember,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: kickedToken,
      onRekey: (event: Readonly<RoomRekeyEvent>) => {
        kickedKeys.set(
          event.keyEpoch,
          event.contentKeys[0] ?? new Uint8Array(0),
        );
      },
    });
    await kickedHandler(
      deliver(epoch1Kicked.command, { kind: "room", path: roomPath }),
    );

    // Epoch 2: only the staying member is rekeyed (the kicked one is gone).
    const epoch2 = await ownerRekeys(
      owner,
      stayingMember,
      roomPath,
      SECOND_EPOCH,
    );
    await stayingHandler(
      deliver(epoch2.command, { kind: "room", path: roomPath }),
    );

    // A member posts under epoch 2.
    const plaintext = new TextEncoder().encode("after the kick");
    const ciphertext = await encryptNoticeContent(
      stayingKeys.get(SECOND_EPOCH) ?? new Uint8Array(0),
      plaintext,
    );
    const notice = await createRoomNotice({
      identity: stayingMember,
      clock: fixedClock(NOW_MS),
      room: roomPath,
      token: stayingToken,
      noticeId: Uint8Array.from([THIRD_NOTICE_ID]),
      contentType: encryptedContentType("text/plain"),
      content: ciphertext,
      keyEpoch: SECOND_EPOCH,
    });
    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });
    expect(verdict.ok).toBe(true);

    // The staying member decrypts with its epoch-2 key; the kicked member, holding only epoch 1, cannot -- rotation protects future content.
    expect(
      await decryptNoticeContent(
        stayingKeys.get(SECOND_EPOCH) ?? new Uint8Array(0),
        ciphertext,
      ),
    ).toEqual(plaintext);
    await expect(
      decryptNoticeContent(
        kickedKeys.get(FIRST_EPOCH) ?? new Uint8Array(0),
        ciphertext,
      ),
    ).rejects.toThrow();
  });
});
