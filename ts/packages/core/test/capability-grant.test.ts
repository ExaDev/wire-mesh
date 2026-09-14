import { webcrypto } from "node:crypto";
import { cdeEncodeOptions, encode } from "cbor2";
import { describe, expect, it, vi } from "vitest";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { Clock } from "../src/ports/clock.js";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  ManageCommand,
  TokenClaims,
} from "../src/generated/protocol.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "../src/domain/mesh-session.js";
import type { RevocationCheck } from "../src/domain/tokens.js";
import { mintCapabilityToken } from "../src/domain/tokens.js";
import {
  buildCapabilityGrantCommand,
  createCapabilityGrantHandler,
  sendCapabilityGrant,
  type CapabilityGrantEvent,
} from "../src/domain/capability-grant.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;
const NOW_MS = 1_893_456_000_000;
const TEST_CAPABILITY = "room:member";
const TEST_SCOPE: CapabilityScope = { kind: "room", path: "some-room" };

async function generateEs256Identity(): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return createNodeIdentity(keyPair.privateKey, publicKeyBytes, ES256);
}

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

const neverRevoked: RevocationCheck = {
  isRevoked: async () => Promise.resolve(false),
};

let issuedTokenIds = 0;
function nextTokenId(): Uint8Array<ArrayBuffer> {
  issuedTokenIds += 1;
  return Uint8Array.from([issuedTokenIds]);
}

interface TokenSeed {
  tokenId: Uint8Array<ArrayBuffer>;
  bearer: DeviceId;
  capability: string;
  scope: CapabilityScope;
  expires: number;
}

function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function encodeBuf(value: unknown): Uint8Array<ArrayBuffer> {
  return buf(encode(value, cdeEncodeOptions));
}

/** Signs a token directly against raw claims (bypassing mintCapabilityToken's own narrowing/expiry checks) so a test can construct a deliberately invalid token -- e.g. one bearing the wrong device-id, or one whose payload the signer never actually produced honestly. Mirrors room-client.test.ts's own identical helper. */
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

function fakeSession(): MeshSession {
  return {
    sendManageRequest: vi.fn(),
  } as unknown as MeshSession;
}

function fakeIncoming(
  command: ManageCommand,
  scope: Readonly<CapabilityScope> = TEST_SCOPE,
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

describe("buildCapabilityGrantCommand", () => {
  it("carries the capability string as the outer verb and the granted token in params", () => {
    const token: CapabilityToken = [
      new Uint8Array(0),
      {},
      null,
      new Uint8Array(0),
    ];
    expect(buildCapabilityGrantCommand(TEST_CAPABILITY, token)).toEqual({
      verb: TEST_CAPABILITY,
      params: { verb: "capability.grant", "granted-token": token },
    } satisfies ManageCommand);
  });
});

describe("sendCapabilityGrant", () => {
  it("sends the grant scoped to the given scope, with no targetDevice by default", async () => {
    const session = fakeSession();
    const token: CapabilityToken = [
      new Uint8Array(0),
      {},
      null,
      new Uint8Array(0),
    ];
    vi.mocked(session.sendManageRequest).mockResolvedValue({ result: "ok" });

    const outcome = await sendCapabilityGrant(
      session,
      TEST_CAPABILITY,
      token,
      TEST_SCOPE,
    );

    expect(outcome).toEqual({ result: "ok" });
    expect(session.sendManageRequest).toHaveBeenCalledTimes(1);
    const [command, scope, targetDevice] = vi.mocked(session.sendManageRequest)
      .mock.calls[0] as [ManageCommand, CapabilityScope, DeviceId | undefined];
    expect(command).toEqual(
      buildCapabilityGrantCommand(TEST_CAPABILITY, token),
    );
    expect(scope).toEqual(TEST_SCOPE);
    expect(targetDevice).toBeUndefined();
  });

  it("forwards targetDevice when given", async () => {
    const session = fakeSession();
    const token: CapabilityToken = [
      new Uint8Array(0),
      {},
      null,
      new Uint8Array(0),
    ];
    const target = (await generateEs256Identity()).deviceId;
    vi.mocked(session.sendManageRequest).mockResolvedValue({ result: "ok" });

    await sendCapabilityGrant(
      session,
      TEST_CAPABILITY,
      token,
      TEST_SCOPE,
      target,
    );

    const [, , targetDevice] = vi.mocked(session.sendManageRequest).mock
      .calls[0] as [unknown, unknown, DeviceId | undefined];
    expect(targetDevice).toBe(target);
  });
});

describe("createCapabilityGrantHandler", () => {
  async function makeHandler(overrides?: {
    onGrant?: (event: Readonly<CapabilityGrantEvent>) => void;
    capability?: string;
  }): Promise<{
    handle: (incoming: Readonly<IncomingManageRequest>) => Promise<void>;
    granter: IdentityPort;
    recipient: IdentityPort;
    onGrant: ReturnType<typeof vi.fn>;
  }> {
    const granter = await generateEs256Identity();
    const recipient = await generateEs256Identity();
    const onGrant =
      overrides?.onGrant !== undefined
        ? vi.fn(overrides.onGrant)
        : vi.fn<(event: Readonly<CapabilityGrantEvent>) => void>();
    const handle = createCapabilityGrantHandler({
      capability: overrides?.capability ?? TEST_CAPABILITY,
      identity: recipient,
      clock: fixedClock(NOW_MS),
      revocation: neverRevoked,
      granterDevice: granter.deviceId,
      onGrant,
    });
    return { handle, granter, recipient, onGrant };
  }

  async function validGrantToken(
    granter: IdentityPort,
    recipient: IdentityPort,
    overrides?: Partial<{
      capability: string;
      scope: CapabilityScope;
      bearer: DeviceId;
      expires: number;
    }>,
  ): Promise<CapabilityToken> {
    const verdict = await mintCapabilityToken({
      identity: granter,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: overrides?.bearer ?? recipient.deviceId,
      capability: overrides?.capability ?? TEST_CAPABILITY,
      scope: overrides?.scope ?? TEST_SCOPE,
      expires: overrides?.expires ?? NOW_MS + HOUR_MS,
    });
    if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);
    return verdict.token;
  }

  it("refuses a grant whose outer verb does not match this handler's own capability", async () => {
    const { handle, onGrant, granter, recipient } = await makeHandler({
      capability: "exec:pty",
    });
    const token = await validGrantToken(granter, recipient);
    const { incoming, respond } = fakeIncoming(
      buildCapabilityGrantCommand(TEST_CAPABILITY, token),
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "malformed",
    });
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("refuses a malformed params payload (no granted-token field)", async () => {
    const { handle, onGrant } = await makeHandler();
    const { incoming, respond } = fakeIncoming({
      verb: TEST_CAPABILITY,
      params: { verb: "capability.grant" },
    });

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "malformed",
    });
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("obligation 1: refuses a token whose bearer is not this handler's own identity", async () => {
    const { handle, onGrant, granter, recipient } = await makeHandler();
    const someoneElse = await generateEs256Identity();
    const token = await validGrantToken(granter, recipient, {
      bearer: someoneElse.deviceId,
    });
    const { incoming, respond } = fakeIncoming(
      buildCapabilityGrantCommand(TEST_CAPABILITY, token),
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "bearer_mismatch",
    });
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("obligation 2: refuses a token whose own capability claim does not match the outer verb", async () => {
    const { handle, onGrant, granter, recipient } = await makeHandler();
    const token = await validGrantToken(granter, recipient, {
      capability: "exec:pty",
    });
    // Outer verb still names the handler's own capability -- exec:pty is the token's own inner claim, mismatching it.
    const command = buildCapabilityGrantCommand(TEST_CAPABILITY, token);
    const { incoming, respond } = fakeIncoming(command);

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "capability_mismatch",
    });
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("obligation 3: refuses a token that fails ordinary verification (bad signature)", async () => {
    const { handle, onGrant, granter, recipient } = await makeHandler();
    const token = await signToken(granter, {
      tokenId: nextTokenId(),
      bearer: recipient.deviceId,
      capability: TEST_CAPABILITY,
      scope: TEST_SCOPE,
      expires: NOW_MS + HOUR_MS,
    });
    // Corrupt the signature so it no longer verifies against granter's own key.
    const tampered: CapabilityToken = [
      token[0],
      token[1],
      token[2],
      new Uint8Array(token[3].length).fill(0),
    ];
    const { incoming, respond } = fakeIncoming(
      buildCapabilityGrantCommand(TEST_CAPABILITY, tampered),
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "bad_signature",
    });
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("obligation 3: refuses an already-expired token", async () => {
    const { handle, onGrant, granter, recipient } = await makeHandler();
    const token = await signToken(granter, {
      tokenId: nextTokenId(),
      bearer: recipient.deviceId,
      capability: TEST_CAPABILITY,
      scope: TEST_SCOPE,
      expires: NOW_MS - 1,
    });
    const { incoming, respond } = fakeIncoming(
      buildCapabilityGrantCommand(TEST_CAPABILITY, token),
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "expired",
    });
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("obligation 3: refuses a token revoked by its own issuer", async () => {
    const granter = await generateEs256Identity();
    const recipient = await generateEs256Identity();
    const revokedTokenId = nextTokenId();
    const revocation: RevocationCheck = {
      isRevoked: async (tokenId, issuer) =>
        Promise.resolve(
          deviceIdToHex(issuer) === deviceIdToHex(granter.deviceId) &&
            tokenId.length === revokedTokenId.length &&
            tokenId.every((byte, index) => byte === revokedTokenId[index]),
        ),
    };
    const onGrant = vi.fn<(event: Readonly<CapabilityGrantEvent>) => void>();
    const handle = createCapabilityGrantHandler({
      capability: TEST_CAPABILITY,
      identity: recipient,
      clock: fixedClock(NOW_MS),
      revocation,
      granterDevice: granter.deviceId,
      onGrant,
    });
    const token = await signToken(granter, {
      tokenId: revokedTokenId,
      bearer: recipient.deviceId,
      capability: TEST_CAPABILITY,
      scope: TEST_SCOPE,
      expires: NOW_MS + HOUR_MS,
    });
    const { incoming, respond } = fakeIncoming(
      buildCapabilityGrantCommand(TEST_CAPABILITY, token),
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "revoked",
    });
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("obligation 4: refuses a token whose scope does not equal-or-root the enclosing request's own scope", async () => {
    const { handle, onGrant, granter, recipient } = await makeHandler();
    const token = await validGrantToken(granter, recipient, {
      scope: { kind: "room", path: "some-other-room" },
    });
    const { incoming, respond } = fakeIncoming(
      buildCapabilityGrantCommand(TEST_CAPABILITY, token),
      TEST_SCOPE,
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "scope_mismatch",
    });
    expect(onGrant).not.toHaveBeenCalled();
  });

  it("obligation 4: accepts a token scoped to a root the request's own scope narrows", async () => {
    const { handle, onGrant, granter, recipient } = await makeHandler();
    // The token's own scope carries no path (a whole-kind root); the request's own scope narrows it by naming a specific path -- an acceptable root per obligation 4.
    const token = await validGrantToken(granter, recipient, {
      scope: { kind: "room" },
    });
    const { incoming, respond } = fakeIncoming(
      buildCapabilityGrantCommand(TEST_CAPABILITY, token),
      TEST_SCOPE,
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({ result: "ok" });
    expect(onGrant).toHaveBeenCalledTimes(1);
  });

  it("accepts a fully valid grant, responds ok, and invokes onGrant with the verified fields", async () => {
    let seen: CapabilityGrantEvent | undefined;
    const { handle, granter, recipient } = await makeHandler({
      onGrant: (event) => {
        seen = event;
      },
    });
    const token = await validGrantToken(granter, recipient);
    const { incoming, respond } = fakeIncoming(
      buildCapabilityGrantCommand(TEST_CAPABILITY, token),
      TEST_SCOPE,
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({ result: "ok" });
    if (seen === undefined) throw new Error("onGrant never fired");
    expect(seen.capability).toBe(TEST_CAPABILITY);
    expect(seen.grantedToken).toEqual(token);
    expect(seen.scope).toEqual(TEST_SCOPE);
    expect(deviceIdToHex(seen.granterDevice)).toBe(
      deviceIdToHex(granter.deviceId),
    );
  });

  it("responds ok before invoking onGrant -- validation success, not application handling, is what the wire response reports", async () => {
    const calls: string[] = [];
    const granter = await generateEs256Identity();
    const recipient = await generateEs256Identity();
    const token = await validGrantToken(granter, recipient);
    const respond = vi.fn(async (): Promise<void> => {
      calls.push("respond");
      return Promise.resolve();
    });
    const handle = createCapabilityGrantHandler({
      capability: TEST_CAPABILITY,
      identity: recipient,
      clock: fixedClock(NOW_MS),
      revocation: neverRevoked,
      granterDevice: granter.deviceId,
      onGrant: () => {
        calls.push("onGrant");
      },
    });
    const incoming: IncomingManageRequest = {
      requestId: 0,
      command: buildCapabilityGrantCommand(TEST_CAPABILITY, token),
      scope: TEST_SCOPE,
      respond,
    };

    await handle(incoming);

    expect(calls).toEqual(["respond", "onGrant"]);
  });
});

describe("round trip: sendCapabilityGrant against createCapabilityGrantHandler", () => {
  it("delivers a real, independently-verifiable token end to end", async () => {
    const granter = await generateEs256Identity();
    const recipient = await generateEs256Identity();
    const verdict = await mintCapabilityToken({
      identity: granter,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: recipient.deviceId,
      capability: TEST_CAPABILITY,
      scope: TEST_SCOPE,
      expires: NOW_MS + HOUR_MS,
    });
    if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);

    let seen: CapabilityGrantEvent | undefined;
    const handle = createCapabilityGrantHandler({
      capability: TEST_CAPABILITY,
      identity: recipient,
      clock: fixedClock(NOW_MS),
      revocation: neverRevoked,
      granterDevice: granter.deviceId,
      onGrant: (event) => {
        seen = event;
      },
    });

    const session = fakeSession();
    vi.mocked(session.sendManageRequest).mockImplementation(
      async (command): Promise<ManageOutcome> => {
        const { incoming, respond } = fakeIncoming(command, TEST_SCOPE);
        await handle(incoming);
        return respond.mock.calls[0]?.[0] as ManageOutcome;
      },
    );

    const outcome = await sendCapabilityGrant(
      session,
      TEST_CAPABILITY,
      verdict.token,
      TEST_SCOPE,
    );

    expect(outcome).toEqual({ result: "ok" });
    if (seen === undefined) throw new Error("onGrant never fired");
    expect(seen.grantedToken).toEqual(verdict.token);
  });
});
