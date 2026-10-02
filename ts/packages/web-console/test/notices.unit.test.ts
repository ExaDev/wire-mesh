import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { ownerNamedRoomPath } from "wire-mesh-core/domain/room-path";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  deriveWrappingKey,
  generateContentKey,
  wrapContentKey,
} from "wire-mesh-core/domain/group-key";
import {
  buildRoomRekeyCommand,
  createRoomRekeyHandler,
  type RoomRekeyEvent,
} from "wire-mesh-core/domain/room-rekey";
import type { RoomKeyStore } from "wire-mesh-core/domain/notice-board";
import type { MeshSession } from "wire-mesh-core/domain/mesh-session";
import type {
  CapabilityToken,
  DataHaveFrame,
  DeviceId,
  Frame,
  ManageCommand,
} from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import {
  bootstrapDmEpoch1,
  createNoticeWiring,
  type DataFrameSender,
  type RoomKeyDelivery,
  type NoticeWiring,
} from "../src/notices.js";

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

function memoryDelivery(delivered: readonly string[] = []): RoomKeyDelivery {
  const rooms = new Set(delivered);
  return {
    isDelivered: async (room) => Promise.resolve(rooms.has(room)),
    markDelivered: async (room) => {
      rooms.add(room);
      return Promise.resolve();
    },
  };
}

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

/** A minimal MeshSession double: sendDataFrame records frames, sendManageRequest records commands; every other member is a stub the wiring and bootstrap never touch. Structurally complete (no type assertion -- the config bans them), so a future interface gain shows up here as a compile error rather than sailing through on a cast. */
function fakeSession(): MeshSession & {
  sent: Frame[];
  commands: ManageCommand[];
  /** Makes every later manage-request come back as an error with this code, or succeed again when undefined. */
  refuseManageRequests: (code: string | undefined) => void;
} {
  let refusal: string | undefined;
  const sent: Frame[] = [];
  const commands: ManageCommand[] = [];
  const emptyStream = <T>(): AsyncIterable<T> => ({
    [Symbol.asyncIterator]() {
      return {
        next: async () =>
          Promise.resolve<IteratorResult<T>>({ value: undefined, done: true }),
      };
    },
  });
  const unimplemented = (member: string): never => {
    throw new Error(`the session double does not implement ${member}`);
  };
  return {
    sent,
    commands,
    refuseManageRequests: (code) => {
      refusal = code;
    },
    events: emptyStream(),
    incomingManageRequests: emptyStream(),
    revocationAnnouncements: emptyStream(),
    coordinatorFrames: emptyStream(),
    incomingDataFrames: emptyStream(),
    connect: () => unimplemented("connect"),
    sendPing: () => unimplemented("sendPing"),
    sendPingMeasureRtt: () => unimplemented("sendPingMeasureRtt"),
    setToken: () => unimplemented("setToken"),
    sendRevocationAnnounce: () => unimplemented("sendRevocationAnnounce"),
    sendCoordinatorClaim: () => unimplemented("sendCoordinatorClaim"),
    sendGossipUpdate: () => unimplemented("sendGossipUpdate"),
    getTopologyPeers: () => unimplemented("getTopologyPeers"),
    close: async () => Promise.resolve(),
    sendDataFrame: async (frame: Frame) => {
      sent.push(frame);
      return Promise.resolve();
    },
    sendManageRequest: async (command: ManageCommand) => {
      commands.push(command);
      return Promise.resolve(
        refusal === undefined
          ? ({ result: "ok" } as const)
          : ({ result: "error", code: refusal } as const),
      );
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Cross-delivery drain: forward each side's outbound frames to the other wiring, flushing async handlers between hops, until neither side queues anything further -- a bounded stand-in for real transports. */
async function drain(
  ownerSession: MeshSession & { sent: Frame[] },
  ownerWiring: NoticeWiring,
  memberSession: MeshSession & { sent: Frame[] },
  memberWiring: NoticeWiring,
): Promise<void> {
  const MAX_DRAIN_ROUNDS = 8;
  for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
    const ownerFrames = ownerSession.sent.splice(0);
    const memberFrames = memberSession.sent.splice(0);
    if (ownerFrames.length === 0 && memberFrames.length === 0) break;
    for (const f of ownerFrames) memberWiring.handleFrame(f, memberSession);
    for (const f of memberFrames) ownerWiring.handleFrame(f, ownerSession);
    await flush();
  }
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

describe("bootstrapDmEpoch1", () => {
  it("the lower participant mints epoch 1 and the higher side unwraps it through the real handler path", async () => {
    const a = await generateEs256Identity();
    const b = await generateEs256Identity();
    const aHex = deviceIdToHex(a.deviceId);
    const bHex = deviceIdToHex(b.deviceId);
    const lower = aHex < bHex ? a : b;
    const higher = aHex < bHex ? b : a;
    const lowerHex = aHex < bHex ? aHex : bHex;
    const higherHex = aHex < bHex ? bHex : aHex;
    const roomPath = `${lowerHex}+${higherHex}`;

    // DM convention: each side's own token is granted by the other.
    const lowerToken = await mintRoomMemberToken(higher, lower, roomPath);
    const higherToken = await mintRoomMemberToken(lower, higher, roomPath);

    const lowerSession = fakeSession();
    const lowerKeys = memoryKeyStore();
    const higherKeys = memoryKeyStore();

    await bootstrapDmEpoch1({
      session: lowerSession,
      identity: lower,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: lowerToken,
      roomPath,
      roomKeys: lowerKeys,
      delivery: memoryDelivery(),
    });

    // The lower side stored its own epoch-1 key and sent exactly one rekey
    // (a manage-request, recorded by the session double).
    expect(await lowerKeys.currentEpoch(roomPath)).toBe(1);
    expect(lowerSession.commands).toHaveLength(1);

    // Deliver the rekey to the higher side's handler.
    const command = lowerSession.commands[0];
    if (command === undefined) {
      throw new Error("expected exactly one sent rekey command");
    }
    const handler = createRoomRekeyHandler({
      identity: higher,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: higherToken,
      onRekey: async (event: Readonly<RoomRekeyEvent>) => {
        for (const [i, key] of event.contentKeys.entries()) {
          await higherKeys.set(
            roomPath,
            event.keyEpoch - event.contentKeys.length + 1 + i,
            key,
          );
        }
      },
    });
    await handler({
      requestId: 0,
      command,
      scope: { kind: "room", path: roomPath },
      respond: vi.fn(async (): Promise<void> => Promise.resolve()),
    });

    // The higher side now holds the SAME epoch-1 key as the lower side.
    const lowerKey = await lowerKeys.get(roomPath, 1);
    const higherKey = await higherKeys.get(roomPath, 1);
    expect(lowerKey).toBeDefined();
    expect(higherKey).toEqual(lowerKey);
  });

  it("is a no-op for the higher participant and when an epoch already exists", async () => {
    const a = await generateEs256Identity();
    const b = await generateEs256Identity();
    const aHex = deviceIdToHex(a.deviceId);
    const bHex = deviceIdToHex(b.deviceId);
    const lower = aHex < bHex ? a : b;
    const higher = aHex < bHex ? b : a;
    const lowerHex = aHex < bHex ? aHex : bHex;
    const higherHex = aHex < bHex ? bHex : aHex;
    const roomPath = `${lowerHex}+${higherHex}`;
    const higherToken = await mintRoomMemberToken(lower, higher, roomPath);

    const higherSession = fakeSession();
    const higherKeys = memoryKeyStore();
    await bootstrapDmEpoch1({
      session: higherSession,
      identity: higher,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: higherToken,
      roomPath,
      roomKeys: higherKeys,
      delivery: memoryDelivery(),
    });
    expect(higherSession.commands).toHaveLength(0);
    expect(await higherKeys.currentEpoch(roomPath)).toBeUndefined();

    // Idempotent for the lower side once the peer has acknowledged the key.
    const lowerToken = await mintRoomMemberToken(higher, lower, roomPath);
    const lowerSession = fakeSession();
    const lowerKeys = memoryKeyStore();
    await lowerKeys.set(roomPath, 1, generateContentKey());
    await bootstrapDmEpoch1({
      session: lowerSession,
      identity: lower,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: lowerToken,
      roomPath,
      roomKeys: lowerKeys,
      delivery: memoryDelivery([roomPath]),
    });
    expect(lowerSession.commands).toHaveLength(0);
  });
});

describe("bootstrapDmEpoch1 redelivery", () => {
  async function dmPair(): Promise<{
    lower: IdentityPort;
    lowerToken: CapabilityToken;
    roomPath: string;
  }> {
    const a = await generateEs256Identity();
    const b = await generateEs256Identity();
    const aIsLower = deviceIdToHex(a.deviceId) < deviceIdToHex(b.deviceId);
    const lower = aIsLower ? a : b;
    const higher = aIsLower ? b : a;
    const roomPath = `${deviceIdToHex(lower.deviceId)}+${deviceIdToHex(higher.deviceId)}`;
    return {
      lower,
      lowerToken: await mintRoomMemberToken(higher, lower, roomPath),
      roomPath,
    };
  }

  it("sends the same first epoch key again until the peer has taken it", async () => {
    const { lower, lowerToken, roomPath } = await dmPair();
    const session = fakeSession();
    const keys = memoryKeyStore();
    const delivery = memoryDelivery();
    const options = {
      session,
      identity: lower,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: lowerToken,
      roomPath,
      roomKeys: keys,
      delivery,
    };

    session.refuseManageRequests("no_token");
    await expect(bootstrapDmEpoch1(options)).rejects.toThrow("no_token");
    const minted = await keys.get(roomPath, 1);
    expect(await delivery.isDelivered(roomPath)).toBe(false);

    session.refuseManageRequests(undefined);
    await bootstrapDmEpoch1(options);

    expect(await keys.get(roomPath, 1)).toEqual(minted);
    expect(session.commands).toHaveLength(2);
    expect(await delivery.isDelivered(roomPath)).toBe(true);

    await bootstrapDmEpoch1(options);
    expect(session.commands).toHaveLength(2);
  });
});

describe("createNoticeWiring", () => {
  it("a posted notice replicates to the peer and decrypts there, end to end over the frame flow", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const memberToken = await mintRoomMemberToken(owner, member, roomPath);

    // Both sides share the epoch-1 content key: the owner generated it, the member received it through the real rekey-handler path.
    const epochKey = generateContentKey();
    const ownerKeys = memoryKeyStore();
    await ownerKeys.set(roomPath, FIRST_EPOCH, epochKey);
    const memberKeys = memoryKeyStore();
    const sharedSecret = await owner.deriveSharedSecret?.(member.identityKey);
    if (sharedSecret === undefined) throw new Error("no ECDH");
    const wrappingKey = await deriveWrappingKey(sharedSecret, {
      room: roomPath,
      keyEpoch: FIRST_EPOCH,
    });
    const wrapped = await wrapContentKey(wrappingKey, epochKey);
    await createRoomRekeyHandler({
      identity: member,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: memberToken,
      onRekey: async (event: Readonly<RoomRekeyEvent>) => {
        for (const [i, key] of event.contentKeys.entries()) {
          await memberKeys.set(
            roomPath,
            event.keyEpoch - event.contentKeys.length + 1 + i,
            key,
          );
        }
      },
    })({
      requestId: 0,
      command: buildRoomRekeyCommand(FIRST_EPOCH, wrapped),
      scope: { kind: "room", path: roomPath },
      respond: vi.fn(async (): Promise<void> => Promise.resolve()),
    });

    const ownerSession = fakeSession();
    const memberSession = fakeSession();
    let memberChanges = 0;
    const ownerWiring = createNoticeWiring({
      senders: () => [ownerSession],
      storage: createMemoryStorage(),
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: ownerKeys,
      onChange: () => undefined,
    });
    const memberWiring = createNoticeWiring({
      senders: () => [memberSession],
      storage: createMemoryStorage(),
      identity: member,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: memberKeys,
      onChange: () => {
        memberChanges += 1;
      },
    });

    const ownerToken = await mintRoomMemberToken(owner, owner, roomPath);
    await ownerWiring.post({
      room: roomPath,
      token: ownerToken,
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("replicated and secret"),
    });
    await drain(ownerSession, ownerWiring, memberSession, memberWiring);

    // The full catch-up round trip flowed (announce, request, entries --
    // ownerSession.sent was drained into the member); assert on the
    // member's received state: its storage holds the owner's entry and its
    // read returns the decrypted notice.
    expect(memberChanges).toBeGreaterThan(0);
    const memberRead = await memberWiring.readRoom(roomPath, [owner.deviceId]);
    const replicated = memberRead.find(
      (n) => n.verified && n.plaintext !== undefined,
    );
    expect(replicated?.plaintext).toEqual(
      new TextEncoder().encode("replicated and secret"),
    );
    expect(replicated?.contentType).toBe("text/plain");
  });

  it("readRoom includes this side's own log even with no peers tracked", async () => {
    const owner = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const ownerToken = await mintRoomMemberToken(owner, owner, roomPath);
    const keys = memoryKeyStore();
    await keys.set(roomPath, FIRST_EPOCH, generateContentKey());
    const session = fakeSession();
    const wiring = createNoticeWiring({
      senders: () => [session],
      storage: createMemoryStorage(),
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: keys,
      onChange: () => undefined,
    });

    await wiring.post({
      room: roomPath,
      token: ownerToken,
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("own log only"),
    });

    const read = await wiring.readRoom(roomPath, []);
    expect(read).toHaveLength(1);
    expect(read[0]?.plaintext).toEqual(
      new TextEncoder().encode("own log only"),
    );
    expect(session.sent.some((f) => f.type === "data-have")).toBe(true);
  });

  it("an inbound data-have is answered with a catch-up request through the sender it arrived on", async () => {
    const owner = await generateEs256Identity();
    const peer: DeviceId = Uint8Array.from({ length: 32 }, (_, i) => i);
    const session = fakeSession();
    const wiring = createNoticeWiring({
      senders: () => [session],
      storage: createMemoryStorage(),
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: memoryKeyStore(),
      onChange: () => undefined,
    });

    const have: DataHaveFrame = {
      type: "data-have",
      peer,
      "head-seq": 5,
    };
    wiring.handleFrame(have, session);
    await flush();

    const request = session.sent.find((f) => f.type === "data-request");
    expect(request).toMatchObject({ peer, "from-seq": 0 });
  });

  it("sync announces the own log to a sender and asks it for each peer's log", async () => {
    const owner = await generateEs256Identity();
    const peer: DeviceId = Uint8Array.from({ length: 32 }, (_, i) => i);
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const keys = memoryKeyStore();
    await keys.set(roomPath, FIRST_EPOCH, generateContentKey());
    const hub = fakeSession();
    const wiring = createNoticeWiring({
      senders: () => [],
      storage: createMemoryStorage(),
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: keys,
      onChange: () => undefined,
    });
    await wiring.post({
      room: roomPath,
      token: await mintRoomMemberToken(owner, owner, roomPath),
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("written while unconnected"),
    });

    await wiring.sync(hub, [peer]);

    expect(hub.sent).toEqual([
      { type: "data-have", peer: owner.deviceId, "head-seq": 1 },
      { type: "data-request", peer, "from-seq": 0 },
    ]);
  });

  it("sync announces nothing for an empty own log", async () => {
    const owner = await generateEs256Identity();
    const hub = fakeSession();
    const wiring = createNoticeWiring({
      senders: () => [],
      storage: createMemoryStorage(),
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: memoryKeyStore(),
      onChange: () => undefined,
    });

    await wiring.sync(hub, []);

    expect(hub.sent).toEqual([]);
  });

  it("a post still succeeds when one sender is not connected, and reaches the others", async () => {
    const owner = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const keys = memoryKeyStore();
    await keys.set(roomPath, FIRST_EPOCH, generateContentKey());
    const connected = fakeSession();
    const disconnected: DataFrameSender = {
      sendDataFrame: async () => Promise.reject(new Error("not connected")),
    };
    const wiring = createNoticeWiring({
      senders: () => [disconnected, connected],
      storage: createMemoryStorage(),
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      roomKeys: keys,
      onChange: () => undefined,
    });

    await wiring.post({
      room: roomPath,
      token: await mintRoomMemberToken(owner, owner, roomPath),
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("hello"),
    });

    expect(connected.sent).toHaveLength(1);
    expect(await wiring.readRoom(roomPath, [])).toHaveLength(1);
  });
});
