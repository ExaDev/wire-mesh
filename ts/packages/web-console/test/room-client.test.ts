import { describe, expect, it, vi } from "vitest";
import { cdeEncodeOptions, encode } from "cbor2";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  ManageCommand,
  TokenClaims,
} from "wire-mesh-core/generated/protocol";
import { roomJoinOkSchema } from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { RevocationCheck } from "wire-mesh-core/domain/tokens";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import { ROOM_MEMBER_CAPABILITY } from "wire-mesh-core/domain/room-token-verification";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { ownerNamedRoomPath } from "wire-mesh-core/domain/room-path";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import {
  buildRoomSendCommand,
  createRoomRouter,
  requestToJoin,
  sendRoomMessage,
  type IncomingRoomMessage,
  type RoomJoinRequestEvent,
} from "../src/room-client.js";

const HOUR_MS = 3_600_000;
const NOW_MS = 1_893_456_000_000;
const DEVICE_ID_HEX_LENGTH = 64;
const ROOM_PATH = `${"1".repeat(DEVICE_ID_HEX_LENGTH)}/general`;

function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function encodeBuf(value: unknown): Uint8Array<ArrayBuffer> {
  return buf(encode(value, cdeEncodeOptions));
}

let issuedTokenIds = 0;
function nextTokenId(): Uint8Array<ArrayBuffer> {
  issuedTokenIds += 1;
  return buf([issuedTokenIds]);
}

interface TokenSeed {
  tokenId: Uint8Array<ArrayBuffer>;
  bearer: DeviceId;
  capability: string;
  scope: CapabilityScope;
  expires: number;
}

async function signToken(
  identity: IdentityPort,
  seed: Readonly<TokenSeed>,
): Promise<CapabilityToken> {
  const claims: TokenClaims = {
    "token-id": seed.tokenId,
    issuer: identity.deviceId,
    "issuer-key": identity.identityKey,
    bearer: seed.bearer,
    capability: seed.capability,
    scope: seed.scope,
    expires: seed.expires,
  };
  const payload = encodeBuf(claims);
  const protectedHeader = encodeBuf({});
  const toBeSigned = encodeBuf([
    "Signature1",
    protectedHeader,
    new Uint8Array(0),
    payload,
  ]);
  const signature = await identity.sign(toBeSigned);
  return [protectedHeader, {}, payload, signature];
}

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

const neverRevoked: RevocationCheck = {
  isRevoked: async () => Promise.resolve(false),
};

describe("buildRoomSendCommand", () => {
  it("builds a room.send command carrying the room:member capability, message-id, sent-at, and text", () => {
    const messageId = nextTokenId();
    expect(buildRoomSendCommand("hello", messageId, NOW_MS)).toEqual({
      verb: ROOM_MEMBER_CAPABILITY,
      params: {
        verb: "room.send",
        "message-id": messageId,
        "sent-at": NOW_MS,
        text: "hello",
      },
    } satisfies ManageCommand);
  });
});

/** A minimal fake MeshSession: sendManageRequest is a mock the test configures per case, incomingManageRequests is fed by push() -- just enough surface for room-client.ts's own consumption. */
function fakeSession(): {
  session: MeshSession;
  push: (request: IncomingManageRequest) => void;
} {
  const waiters: ((request: IncomingManageRequest) => void)[] = [];
  const backlog: IncomingManageRequest[] = [];
  const session = {
    sendManageRequest: vi.fn(),
    incomingManageRequests: {
      [Symbol.asyncIterator](): AsyncIterator<IncomingManageRequest> {
        return {
          async next(): Promise<IteratorResult<IncomingManageRequest>> {
            const queued = backlog.shift();
            if (queued !== undefined) {
              return Promise.resolve({ value: queued, done: false });
            }
            return new Promise((resolve) => {
              waiters.push((request) => {
                resolve({ value: request, done: false });
              });
            });
          },
        };
      },
    },
  } as unknown as MeshSession;
  return {
    session,
    push(request: IncomingManageRequest): void {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(request);
      } else {
        backlog.push(request);
      }
    },
  };
}

describe("sendRoomMessage", () => {
  it("sends a room.send scoped to the given room path, carrying the given token", async () => {
    const { session } = fakeSession();
    const token: CapabilityToken = [
      new Uint8Array(0),
      {},
      null,
      new Uint8Array(0),
    ];
    const mockOutcome: ManageOutcome = { result: "ok" };
    vi.mocked(session.sendManageRequest).mockResolvedValue(mockOutcome);

    const outcome = await sendRoomMessage(session, ROOM_PATH, "hi", token);

    expect(outcome).toBe(mockOutcome);
    expect(session.sendManageRequest).toHaveBeenCalledTimes(1);
    const [command, scope, targetDevice, sentToken] = vi.mocked(
      session.sendManageRequest,
    ).mock.calls[0] as [
      ManageCommand,
      CapabilityScope,
      DeviceId | undefined,
      CapabilityToken | undefined,
    ];
    expect(command.verb).toBe(ROOM_MEMBER_CAPABILITY);
    expect(scope).toEqual({ kind: "room", path: ROOM_PATH });
    expect(targetDevice).toBeUndefined();
    expect(sentToken).toBe(token);
  });
});

describe("requestToJoin", () => {
  it("resolves with the granted token and member list on approval", async () => {
    const { session } = fakeSession();
    const grantedToken: CapabilityToken = [
      new Uint8Array(0),
      {},
      null,
      new Uint8Array(0),
    ];
    const memberDevice = (await createWebCryptoIdentity()).deviceId;
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "ok",
      "granted-token": grantedToken,
      members: [{ device: memberDevice }],
    });

    const result = await requestToJoin(session, ROOM_PATH);

    expect(result.token).toEqual(grantedToken);
    expect(result.members).toEqual([memberDevice]);
  });

  it("throws when the join is denied", async () => {
    const { session } = fakeSession();
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "error",
      code: "denied",
    });

    await expect(requestToJoin(session, ROOM_PATH)).rejects.toThrow(/denied/);
  });
});

function fakeIncomingRoomSend(
  token: CapabilityToken | undefined,
  params: Record<string, unknown> = {},
  roomPath: string = ROOM_PATH,
): { incoming: IncomingManageRequest; respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn(async (): Promise<void> => Promise.resolve());
  const incoming: IncomingManageRequest = {
    requestId: 0,
    command: {
      verb: ROOM_MEMBER_CAPABILITY,
      params: { verb: "room.send", ...params },
    },
    scope: { kind: "room", path: roomPath },
    ...(token !== undefined ? { token } : {}),
    respond,
  };
  return { incoming, respond };
}

describe("createRoomRouter", () => {
  const messageId = nextTokenId();

  it("delivers a room.send with a validly authorised token to onMessage, and responds ok", async () => {
    const owner = await createWebCryptoIdentity();
    const member = await createWebCryptoIdentity();
    // verifyRoomToken's own chain-root obligation requires the room path's own owner segment to actually be the minting identity's device-id -- ROOM_PATH's fixed "1".repeat(64) owner is a fine placeholder for the pure-sender tests above, which never verify a token, but this test's whole point is real verification, so the path must genuinely be owned by `owner`.
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await signToken(owner, {
      tokenId: nextTokenId(),
      bearer: member.deviceId,
      capability: ROOM_MEMBER_CAPABILITY,
      scope: { kind: "room", path: roomPath },
      expires: NOW_MS + HOUR_MS,
    });
    const { session, push } = fakeSession();
    const onMessage = vi.fn<(message: Readonly<IncomingRoomMessage>) => void>();
    createRoomRouter(
      session,
      {
        identity: owner,
        clock: fixedClock(NOW_MS),
        revocation: neverRevoked,
        peerDevice: member.deviceId,
      },
      { onMessage },
    );

    const { incoming, respond } = fakeIncomingRoomSend(
      token,
      { "message-id": messageId, "sent-at": NOW_MS, text: "hello room" },
      roomPath,
    );
    push(incoming);
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    expect(onMessage).toHaveBeenCalledWith({
      roomPath,
      text: "hello room",
      messageId,
      sentAt: NOW_MS,
    });
    expect(respond).toHaveBeenCalledWith({ result: "ok" });
  });

  it("refuses a room.send with no token, and never calls onMessage", async () => {
    const owner = await createWebCryptoIdentity();
    const member = await createWebCryptoIdentity();
    const { session, push } = fakeSession();
    const onMessage = vi.fn<(message: Readonly<IncomingRoomMessage>) => void>();
    createRoomRouter(
      session,
      {
        identity: owner,
        clock: fixedClock(NOW_MS),
        revocation: neverRevoked,
        peerDevice: member.deviceId,
      },
      { onMessage },
    );

    const { incoming, respond } = fakeIncomingRoomSend(undefined, {
      "message-id": messageId,
      "sent-at": NOW_MS,
      text: "hello room",
    });
    push(incoming);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledTimes(1);
    });

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "unauthorized",
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("mints and returns a fresh token on an accepted room.join, including the joiner in the reported member list", async () => {
    const owner = await createWebCryptoIdentity();
    const joiner = await createWebCryptoIdentity();
    const { session, push } = fakeSession();
    const onJoinRequest = vi.fn<
      (event: Readonly<RoomJoinRequestEvent>) => void
    >((event) => {
      void event.decide({
        kind: "accept",
        capability: ROOM_MEMBER_CAPABILITY,
        expires: NOW_MS + HOUR_MS,
      });
    });
    createRoomRouter(
      session,
      {
        identity: owner,
        clock: fixedClock(NOW_MS),
        revocation: neverRevoked,
        peerDevice: joiner.deviceId,
        currentMembers: () => [owner.deviceId],
      },
      { onJoinRequest },
    );

    const respond = vi.fn<(outcome: ManageOutcome) => Promise<void>>(async () =>
      Promise.resolve(),
    );
    const incoming: IncomingManageRequest = {
      requestId: 1,
      command: {
        verb: ROOM_MEMBER_CAPABILITY,
        params: {
          verb: "capability.request",
          capability: ROOM_MEMBER_CAPABILITY,
        },
      },
      scope: { kind: "room", path: ROOM_PATH },
      respond,
    };
    push(incoming);

    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledTimes(1);
    });
    expect(onJoinRequest).toHaveBeenCalledTimes(1);
    const call = roomJoinOkSchema.parse(respond.mock.calls[0]?.[0]);
    expect(call["granted-token"]).toBeDefined();
    expect(call.members).toEqual([
      { device: owner.deviceId },
      { device: joiner.deviceId },
    ]);
  });

  it("responds with an ordinary manage-error on a rejected room.join", async () => {
    const owner = await createWebCryptoIdentity();
    const joiner = await createWebCryptoIdentity();
    const { session, push } = fakeSession();
    const onJoinRequest = vi.fn<
      (event: Readonly<RoomJoinRequestEvent>) => void
    >((event) => {
      void event.decide({ kind: "reject", reason: "not now" });
    });
    createRoomRouter(
      session,
      {
        identity: owner,
        clock: fixedClock(NOW_MS),
        revocation: neverRevoked,
        peerDevice: joiner.deviceId,
      },
      { onJoinRequest },
    );

    const respond = vi.fn(async (): Promise<void> => Promise.resolve());
    const incoming: IncomingManageRequest = {
      requestId: 2,
      command: {
        verb: ROOM_MEMBER_CAPABILITY,
        params: {
          verb: "capability.request",
          capability: ROOM_MEMBER_CAPABILITY,
        },
      },
      scope: { kind: "room", path: ROOM_PATH },
      respond,
    };
    push(incoming);

    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith({
        result: "error",
        code: "denied",
        message: "not now",
      });
    });
  });
});
