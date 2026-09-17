import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import { mintCapabilityToken } from "../src/domain/tokens.js";
import { createRevocationView } from "../src/domain/revocation-view.js";
import { dmRoomPath, ownerNamedRoomPath } from "../src/domain/room-path.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import {
  deriveWrappingKey,
  generateContentKey,
  wrapContentKey,
} from "../src/domain/group-key.js";
import {
  buildRoomRekeyCommand,
  createRoomRekeyHandler,
  sendRoomRekey,
  type RoomRekeyEvent,
} from "../src/domain/room-rekey.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { Clock } from "../src/ports/clock.js";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  ManageCommand,
} from "../src/generated/protocol.js";
import type {
  IncomingManageRequest,
  MeshSession,
} from "../src/domain/mesh-session.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;
const NOW_MS = 1_893_456_000_000;
const EXPIRES_MS = NOW_MS + HOUR_MS;
const TEST_KEY_EPOCH = 3;
const SINGLE_BYTE_WRAPPED_KEY_VALUE = 9;
const DEVICE_ID_HEX_LENGTH = 32;

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

/** Generates an ES256 identity wired for deriveSharedSecret -- see node-identity.test.ts's own identical helper for why this is the caller's responsibility rather than createNodeIdentity's default. */
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

let issuedTokenIds = 0;
function nextTokenId(): Uint8Array<ArrayBuffer> {
  issuedTokenIds += 1;
  return Uint8Array.from([issuedTokenIds]);
}

async function mintRoomMemberToken(
  issuer: IdentityPort,
  bearer: IdentityPort,
  roomPath: string,
): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock: fixedClock(NOW_MS),
    tokenId: nextTokenId(),
    bearer: bearer.deviceId,
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: EXPIRES_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);
  return verdict.token;
}

function fakeSession(): MeshSession {
  return { sendManageRequest: vi.fn() } as unknown as MeshSession;
}

function fakeIncoming(
  command: ManageCommand,
  scope: Readonly<CapabilityScope>,
): { incoming: IncomingManageRequest; respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn(async (): Promise<void> => Promise.resolve());
  const incoming: IncomingManageRequest = {
    requestId: 0,
    command,
    scope,
    respond,
  };
  return { incoming, respond };
}

describe("buildRoomRekeyCommand", () => {
  it("carries room:member as the outer verb and the epoch/wrapped-key in params", () => {
    const wrappedKey = Uint8Array.from([1, 2, TEST_KEY_EPOCH]);
    expect(buildRoomRekeyCommand(TEST_KEY_EPOCH, wrappedKey)).toEqual({
      verb: "room:member",
      params: {
        verb: "room.rekey",
        "key-epoch": TEST_KEY_EPOCH,
        "wrapped-key": wrappedKey,
      },
    } satisfies ManageCommand);
  });
});

describe("sendRoomRekey", () => {
  it("sends the command scoped to the given room path", async () => {
    const session = fakeSession();
    vi.mocked(session.sendManageRequest).mockResolvedValue({ result: "ok" });
    const wrappedKey = Uint8Array.from([SINGLE_BYTE_WRAPPED_KEY_VALUE]);
    const roomPath = ownerNamedRoomPath(
      "aa".repeat(DEVICE_ID_HEX_LENGTH),
      "general",
    );

    const outcome = await sendRoomRekey(session, roomPath, 1, wrappedKey);

    expect(outcome).toEqual({ result: "ok" });
    const [command, scope] = vi.mocked(session.sendManageRequest).mock
      .calls[0] as [ManageCommand, CapabilityScope, DeviceId | undefined];
    expect(command).toEqual(buildRoomRekeyCommand(1, wrappedKey));
    expect(scope).toEqual({ kind: "room", path: roomPath });
  });
});

describe("createRoomRekeyHandler", () => {
  async function setUp() {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const memberToken = await mintRoomMemberToken(owner, member, roomPath);
    const onRekey = vi.fn<(event: Readonly<RoomRekeyEvent>) => void>();
    const handler = createRoomRekeyHandler({
      identity: member,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: memberToken,
      onRekey,
    });
    return { owner, member, roomPath, handler, onRekey };
  }

  async function ownerWraps(
    owner: IdentityPort,
    member: IdentityPort,
    roomPath: string,
    keyEpoch: number,
    contentKey: Uint8Array,
  ): Promise<Uint8Array> {
    if (owner.deriveSharedSecret === undefined) {
      throw new Error("owner identity must expose deriveSharedSecret");
    }
    const sharedSecret = await owner.deriveSharedSecret(member.identityKey);
    const wrappingKey = await deriveWrappingKey(sharedSecret, {
      room: roomPath,
      keyEpoch,
    });
    return wrapContentKey(wrappingKey, contentKey);
  }

  it("unwraps a single-epoch (bare bstr) room.rekey and reports it via onRekey", async () => {
    const { owner, member, roomPath, handler, onRekey } = await setUp();
    const contentKey = generateContentKey();
    const wrapped = await ownerWraps(owner, member, roomPath, 1, contentKey);
    const { incoming, respond } = fakeIncoming(
      buildRoomRekeyCommand(1, wrapped),
      { kind: "room", path: roomPath },
    );

    await handler(incoming);

    expect(respond).toHaveBeenCalledWith({ result: "ok" });
    expect(onRekey).toHaveBeenCalledWith({
      room: roomPath,
      keyEpoch: 1,
      contentKeys: [contentKey],
    });
  });

  it("unwraps a full-history (array) room.rekey, one content key per epoch in order", async () => {
    const { owner, member, roomPath, handler, onRekey } = await setUp();
    const epoch1Key = generateContentKey();
    const epoch2Key = generateContentKey();
    const wrapped1 = await ownerWraps(owner, member, roomPath, 1, epoch1Key);
    const wrapped2 = await ownerWraps(owner, member, roomPath, 2, epoch2Key);
    const { incoming } = fakeIncoming(
      buildRoomRekeyCommand(2, [wrapped1, wrapped2]),
      { kind: "room", path: roomPath },
    );

    await handler(incoming);

    expect(onRekey).toHaveBeenCalledWith({
      room: roomPath,
      keyEpoch: 2,
      contentKeys: [epoch1Key, epoch2Key],
    });
  });

  it("refuses a room.rekey when the caller's own room:member token doesn't verify", async () => {
    const owner = await generateEs256Identity();
    const impostor = await generateEs256Identity();
    const member = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    // Rooted at the impostor, not the room's real owner -- fails obligation 1.
    const badToken = await mintRoomMemberToken(impostor, member, roomPath);
    const onRekey = vi.fn<(event: Readonly<RoomRekeyEvent>) => void>();
    const handler = createRoomRekeyHandler({
      identity: member,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: badToken,
      onRekey,
    });
    const contentKey = generateContentKey();
    const wrapped = await ownerWraps(owner, member, roomPath, 1, contentKey);
    const { incoming, respond } = fakeIncoming(
      buildRoomRekeyCommand(1, wrapped),
      { kind: "room", path: roomPath },
    );

    await handler(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "wrong_chain_root",
    });
    expect(onRekey).not.toHaveBeenCalled();
  });

  it("fails closed on a room.rekey forged by anyone other than the room's real, certified owner", async () => {
    // An attacker with no relationship to the room at all cannot produce a wrapped-key that unwraps correctly under ECDH(member, real-owner) -- doing so needs the real owner's own private key -- so the handler needs no separate live-sender identity check to reject this.
    const { member, roomPath, handler, onRekey } = await setUp();
    const attacker = await generateEs256Identity();
    const contentKey = generateContentKey();
    const wrapped = await ownerWraps(attacker, member, roomPath, 1, contentKey);
    const { incoming, respond } = fakeIncoming(
      buildRoomRekeyCommand(1, wrapped),
      { kind: "room", path: roomPath },
    );

    await handler(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "unwrap_failed",
    });
    expect(onRekey).not.toHaveBeenCalled();
  });

  it("refuses a room.rekey scoped to a different room than the recipient's own token", async () => {
    const { owner, member, handler, onRekey } = await setUp();
    const otherRoomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "other",
    );
    const contentKey = generateContentKey();
    const wrapped = await ownerWraps(
      owner,
      member,
      otherRoomPath,
      1,
      contentKey,
    );
    const { incoming, respond } = fakeIncoming(
      buildRoomRekeyCommand(1, wrapped),
      { kind: "room", path: otherRoomPath },
    );

    await handler(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "wrong_scope_path",
    });
    expect(onRekey).not.toHaveBeenCalled();
  });

  it("refuses a request whose outer verb is not room:member", async () => {
    const { handler, onRekey, roomPath } = await setUp();
    const { incoming, respond } = fakeIncoming(
      {
        verb: "not-room-member",
        params: {
          verb: "room.rekey",
          "key-epoch": 1,
          "wrapped-key": Uint8Array.from([1]),
        },
      },
      { kind: "room", path: roomPath },
    );

    await handler(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "malformed",
    });
    expect(onRekey).not.toHaveBeenCalled();
  });

  it("refuses a request whose scope isn't a room scope at all", async () => {
    const { handler, onRekey } = await setUp();
    const { incoming, respond } = fakeIncoming(
      buildRoomRekeyCommand(1, Uint8Array.from([1])),
      { kind: "node" },
    );

    await handler(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "scope_mismatch",
    });
    expect(onRekey).not.toHaveBeenCalled();
  });

  it("refuses when the local identity has no deriveSharedSecret (e.g. an Ed25519-only identity)", async () => {
    const owner = await generateEs256Identity();
    const member = await generateEs256Identity(); // ECDH-capable, but the handler below is built with a plain, non-ECDH identity for the *recipient* role
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const keyPair = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const publicKeyBytes = new Uint8Array(
      await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
    );
    const nonEcdhMember = await createNodeIdentity(
      keyPair.privateKey,
      publicKeyBytes,
      ES256,
    );
    const memberToken = await mintRoomMemberToken(
      owner,
      nonEcdhMember,
      roomPath,
    );
    const onRekey = vi.fn<(event: Readonly<RoomRekeyEvent>) => void>();
    const handler = createRoomRekeyHandler({
      identity: nonEcdhMember,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: memberToken,
      onRekey,
    });
    const contentKey = generateContentKey();
    const wrapped = await ownerWraps(owner, member, roomPath, 1, contentKey);
    const { incoming, respond } = fakeIncoming(
      buildRoomRekeyCommand(1, wrapped),
      { kind: "room", path: roomPath },
    );

    await handler(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "ecdh_unsupported",
    });
    expect(onRekey).not.toHaveBeenCalled();
  });

  // The DM bootstrap scenario wire-mesh#36's consumer work surfaced: in a DM,
  // each participant's own held token chains to the OTHER side (I approve
  // your join request, minting a grant rooted at me, held by you). The
  // rekey handler must accept that root for a DM path -- both participants
  // are named, equal authorities in the path itself, and the handler's real
  // binding is the ECDH unwrap (a forged rekey needs the root's private key
  // to produce unwrappable ciphertext), not the room.send-grade root rule.
  async function dmSetup(): Promise<{
    alice: IdentityPort;
    bob: IdentityPort;
    roomPath: string;
  }> {
    const a = await generateEs256Identity();
    const b = await generateEs256Identity();
    // dmRoomPath wants the sorted pair; determine who is lower for clarity.
    const aHex = deviceIdToHex(a.deviceId);
    const bHex = deviceIdToHex(b.deviceId);
    const lower = aHex < bHex ? a : b;
    const higher = aHex < bHex ? b : a;
    const path = dmRoomPath(aHex, bHex);
    return { alice: lower, bob: higher, roomPath: path };
  }

  it("unwraps a DM epoch-1 rekey sent by the lower participant, whose root the higher side's own token chains to", async () => {
    const { alice, bob, roomPath } = await dmSetup();
    // bob's own token: granted by alice (the DM convention -- each side's
    // held token is rooted at the other).
    const bobToken = await mintRoomMemberToken(alice, bob, roomPath);
    const onRekey = vi.fn<(event: Readonly<RoomRekeyEvent>) => void>();
    const handler = createRoomRekeyHandler({
      identity: bob,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: bobToken,
      onRekey,
    });
    const contentKey = generateContentKey();
    const wrapped = await ownerWraps(alice, bob, roomPath, 1, contentKey);
    const { incoming, respond } = fakeIncoming(
      buildRoomRekeyCommand(1, wrapped),
      { kind: "room", path: roomPath },
    );

    await handler(incoming);

    expect(respond).toHaveBeenCalledWith({ result: "ok" });
    expect(onRekey).toHaveBeenCalledWith({
      room: roomPath,
      keyEpoch: 1,
      contentKeys: [contentKey],
    });
  });

  it("still refuses a DM rekey rooted at a stranger outside the path", async () => {
    const { alice, bob, roomPath } = await dmSetup();
    const stranger = await generateEs256Identity();
    // bob's token granted by a stranger -- NOT a path participant. Even the
    // rekey-scoped either-participant rule must refuse this root.
    const bobToken = await mintRoomMemberToken(stranger, bob, roomPath);
    const onRekey = vi.fn<(event: Readonly<RoomRekeyEvent>) => void>();
    const handler = createRoomRekeyHandler({
      identity: bob,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      ownRoomMemberToken: bobToken,
      onRekey,
    });
    const contentKey = generateContentKey();
    // alice wraps (a genuine path participant) -- but bob's verified token
    // roots at the stranger, so the derivation target is the stranger's key
    // and the unwrap must fail.
    const wrapped = await ownerWraps(alice, bob, roomPath, 1, contentKey);
    const { incoming, respond } = fakeIncoming(
      buildRoomRekeyCommand(1, wrapped),
      { kind: "room", path: roomPath },
    );

    await handler(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "wrong_chain_root",
    });
    expect(onRekey).not.toHaveBeenCalled();
  });
});
