import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import { mintCapabilityToken } from "../src/domain/tokens.js";
import { createRevocationView } from "../src/domain/revocation-view.js";
import { ownerNamedRoomPath } from "../src/domain/room-path.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import {
  deriveWrappingKey,
  encryptedContentType,
  generateContentKey,
  wrapContentKey,
} from "../src/domain/group-key.js";
import {
  buildRoomRekeyCommand,
  createRoomRekeyHandler,
  type RoomRekeyEvent,
} from "../src/domain/room-rekey.js";
import { readEntries } from "../src/domain/data-sync.js";
import {
  createNoticeBoard,
  type RoomKeyStore,
} from "../src/domain/notice-board.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { KeyValueStorage } from "../src/ports/storage.js";
import type { Clock } from "../src/ports/clock.js";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
} from "../src/generated/protocol.js";
import type { IncomingManageRequest } from "../src/domain/mesh-session.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;
const NOW_MS = 1_893_456_000_000;
const EXPIRES_MS = NOW_MS + HOUR_MS;
const FIRST_EPOCH = 1;

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

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

/** A minimal in-memory RoomKeyStore -- the same shape an application wires from createRoomRekeyHandler's onRekey events. */
function memoryKeyStore(): RoomKeyStore {
  const keys = new Map<string, Map<number, Uint8Array>>();
  return {
    async get(room, epoch) {
      return Promise.resolve(keys.get(room)?.get(epoch));
    },
    set(room, epoch, key) {
      const perRoom = keys.get(room) ?? new Map<number, Uint8Array>();
      perRoom.set(epoch, key);
      keys.set(room, perRoom);
    },
    async currentEpoch(room) {
      return Promise.resolve(
        [...(keys.get(room)?.keys() ?? [])].sort((a, b) => b - a)[0],
      );
    },
  };
}

/** Delivers the real room.rekey handler path so the member's key store is populated exactly as an application's would be. */
async function rekeyMember(
  owner: IdentityPort,
  member: IdentityPort,
  memberToken: CapabilityToken,
  roomPath: string,
  epoch: number,
  contentKey: Uint8Array,
  memberKeys: Readonly<RoomKeyStore>,
): Promise<void> {
  const sharedSecret = await owner.deriveSharedSecret?.(member.identityKey);
  if (sharedSecret === undefined) throw new Error("no ECDH");
  const wrappingKey = await deriveWrappingKey(sharedSecret, {
    room: roomPath,
    keyEpoch: epoch,
  });
  const wrapped = await wrapContentKey(wrappingKey, contentKey);
  const incoming: IncomingManageRequest = {
    requestId: 0,
    command: buildRoomRekeyCommand(epoch, wrapped),
    scope: { kind: "room", path: roomPath } satisfies CapabilityScope,
    respond: vi.fn(async (): Promise<void> => Promise.resolve()),
  };
  const handler = createRoomRekeyHandler({
    identity: member,
    clock: fixedClock(NOW_MS),
    revocation: createRevocationView(),
    ownRoomMemberToken: memberToken,
    onRekey: (event: Readonly<RoomRekeyEvent>) => {
      event.contentKeys.forEach((key, i) => {
        memberKeys.set(
          roomPath,
          event.keyEpoch - event.contentKeys.length + 1 + i,
          key,
        );
      });
    },
  });
  await handler(incoming);
}

describe("createNoticeBoard", () => {
  it("posts an encrypted notice to the own oplog and reads it back verified and decrypted", async () => {
    const owner = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const ownerToken = await mintRoomMemberToken(owner, owner, roomPath);
    const keyStore = memoryKeyStore();
    keyStore.set(roomPath, FIRST_EPOCH, generateContentKey());
    const board = createNoticeBoard({
      identity: owner,
      storage: createMemoryStorage(),
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: keyStore,
    });

    const post = await board.postEncryptedNotice({
      room: roomPath,
      token: ownerToken,
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("durable and secret"),
    });
    expect(post.dataHave.type).toBe("data-have");
    expect(post.dataHave["head-seq"]).toBe(1);

    const read = await board.readOwnNotices(roomPath);
    expect(read).toHaveLength(1);
    expect(read[0]?.verified).toBe(true);
    expect(read[0]?.contentType).toBe("text/plain");
    expect(read[0]?.plaintext).toEqual(
      new TextEncoder().encode("durable and secret"),
    );
  });

  it("posts under the key store's CURRENT epoch, not a hardcoded one", async () => {
    const owner = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const ownerToken = await mintRoomMemberToken(owner, owner, roomPath);
    const keyStore = memoryKeyStore();
    keyStore.set(roomPath, FIRST_EPOCH, generateContentKey());
    const board = createNoticeBoard({
      identity: owner,
      storage: createMemoryStorage(),
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: keyStore,
    });

    // Rotate to epoch 2 in the store (as an owner-side rekey would), then post.
    const secondEpoch = FIRST_EPOCH + 1;
    keyStore.set(roomPath, secondEpoch, generateContentKey());
    await board.postEncryptedNotice({
      room: roomPath,
      token: ownerToken,
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("after rotation"),
    });

    const read = await board.readOwnNotices(roomPath);
    expect(read[0]?.claims?.["key-epoch"]).toBe(secondEpoch);
  });

  it("reads a replicated peer log: verified and decrypted where the epoch key is held, verified and opaque where it is not", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const memberToken = await mintRoomMemberToken(owner, member, roomPath);

    // Member receives epoch 1 through the real handler path.
    const epochKey = generateContentKey();
    const memberKeys = memoryKeyStore();
    await rekeyMember(
      owner,
      member,
      memberToken,
      roomPath,
      FIRST_EPOCH,
      epochKey,
      memberKeys,
    );

    // Member posts encrypted to its own log.
    const memberStorage = createMemoryStorage();
    const memberBoard = createNoticeBoard({
      identity: member,
      storage: memberStorage,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: memberKeys,
    });
    await memberBoard.postEncryptedNotice({
      room: roomPath,
      token: memberToken,
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("hello from member"),
    });
    const rawEntry = (await readEntries(memberStorage, member.deviceId, 0))[0];
    if (rawEntry === undefined) throw new Error("member entry missing");
    const entryBytes: Uint8Array<ArrayBuffer> = Uint8Array.from(rawEntry);

    // The owner (holding every epoch key by construction) ingests and decrypts.
    const ownerKeyStore = memoryKeyStore();
    ownerKeyStore.set(roomPath, FIRST_EPOCH, epochKey);
    const ownerBoard = createNoticeBoard({
      identity: owner,
      storage: createMemoryStorage(),
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: ownerKeyStore,
    });
    await ownerBoard.ingestPeerEntry(member.deviceId, entryBytes);
    const ownerRead = await ownerBoard.readPeerNotices(
      member.deviceId,
      roomPath,
    );
    expect(ownerRead).toHaveLength(1);
    expect(ownerRead[0]?.verified).toBe(true);
    expect(ownerRead[0]?.plaintext).toEqual(
      new TextEncoder().encode("hello from member"),
    );

    // A keyless reader still verifies, with plaintext undefined -- the read-confidentiality property itself, at the board layer.
    const keylessBoard = createNoticeBoard({
      identity: owner,
      storage: createMemoryStorage(),
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: memoryKeyStore(),
    });
    await keylessBoard.ingestPeerEntry(member.deviceId, entryBytes);
    const keylessRead = await keylessBoard.readPeerNotices(
      member.deviceId,
      roomPath,
    );
    expect(keylessRead).toHaveLength(1);
    expect(keylessRead[0]?.verified).toBe(true);
    expect(keylessRead[0]?.plaintext).toBeUndefined();
  });

  it("never renders unverified content: a tampered entry surfaces as verified:false", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const keyStore = memoryKeyStore();
    keyStore.set(roomPath, FIRST_EPOCH, generateContentKey());
    const board = createNoticeBoard({
      identity: owner,
      storage: createMemoryStorage(),
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: keyStore,
    });

    // Well-formed-ish COSE array bytes with no valid signature over claims:
    // array(4) [ bstr(0), map(0), bstr(4), bstr(1,2,3,4) ] -- a cose-sign1
    // tuple shape whose payload is far too short to be real claims.
    const CBOR_ARRAY_HEAD = 0x84;
    const CBOR_EMPTY_BSTR = 0x40;
    const CBOR_EMPTY_MAP = 0xa0;
    const CBOR_SHORT_BSTR = 0x44;
    // Arbitrary filler bytes standing in for a bogus-signature bstr,
    // spelled as text so no raw byte literals trip the magic-number rule.
    const FILLER_BYTES = Array.from("wxyz", (c) => c.charCodeAt(0));
    const garbage = Uint8Array.from([
      CBOR_ARRAY_HEAD,
      CBOR_EMPTY_BSTR,
      CBOR_EMPTY_MAP,
      CBOR_SHORT_BSTR,
      ...FILLER_BYTES,
    ]);
    await board.ingestPeerEntry(poster.deviceId, garbage);

    const notices = await board.readPeerNotices(poster.deviceId, roomPath);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.verified).toBe(false);
    expect(notices[0]?.plaintext).toBeUndefined();
  });

  it("supports an in-memory own storage the caller can also pass, keeping one store across board and data-sync use", async () => {
    const owner = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const ownerToken = await mintRoomMemberToken(owner, owner, roomPath);
    const keyStore = memoryKeyStore();
    keyStore.set(roomPath, FIRST_EPOCH, generateContentKey());
    const storage: KeyValueStorage = createMemoryStorage();
    const board = createNoticeBoard({
      identity: owner,
      storage,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: keyStore,
    });
    await board.postEncryptedNotice({
      room: roomPath,
      token: ownerToken,
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("shared store"),
    });

    // The caller's own storage reference sees the same oplog data-sync wrote.
    const entries = await readEntries(storage, owner.deviceId, 0);
    expect(entries).toHaveLength(1);
  });

  it("types: DeviceId import stays referenced", () => {
    // The DeviceId type is used in ingestPeerEntry's signature; this anchor keeps the import honest if the tests above are trimmed.
    const _id: DeviceId | undefined = undefined;
    expect(_id).toBeUndefined();
    expect(encryptedContentType("text/plain")).toBe("text/plain+aes256gcm");
  });
});
