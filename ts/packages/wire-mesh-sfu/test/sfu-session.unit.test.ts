// Exercises createSfuCall's own orchestration logic (authorization, dispatch to a media backend, sfu-track-map fan-out) against a fully fake SfuMediaBackend and fake MeshSession: no mediasoup, no real network, no SDP parsing. mediasoup-media-backend.integration.test.ts covers the real backend against a real mediasoup Worker.

import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encode, cdeEncodeOptions } from "cbor2";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import type {
  CapabilityToken,
  DeviceId,
  ManageCommand,
} from "wire-mesh-core/generated/protocol";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import type { RevocationCheck } from "wire-mesh-core/domain/tokens";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import {
  WEBRTC_SIGNAL_SCOPE,
  WEBRTC_SIGNAL_VERB,
  buildOfferCommand,
} from "wire-mesh-core/domain/webrtc-signaling";
import { createSfuCall } from "../src/domain/sfu-session.js";
import type {
  BackendTrack,
  JoinResult,
  SfuMediaBackend,
} from "../src/domain/media-backend.js";

const ES256 = -7;
const DEVICE_ID_BYTE_LENGTH = 32;
const HOUR_MS = 3_600_000;
const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;
const NEGOTIATION_ID_B_JOINS_FIRST = 1;
const NEGOTIATION_ID_A_JOINS_SECOND = 2;
const NEGOTIATION_ID_AUTHORIZED_OFFER = 7;
const DEVICE_A_FILL_BYTE = 0x11;
const DEVICE_B_FILL_BYTE = 0x22;
const DEVICE_C_FILL_BYTE = 0x33;

async function generateIdentity(): Promise<IdentityPort> {
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

const neverRevoked: RevocationCheck = {
  entriesFor: async () => Promise.resolve([]),
};

function deviceIdFromFillByte(byte: number): DeviceId {
  return Uint8Array.from({ length: DEVICE_ID_BYTE_LENGTH }, () => byte);
}

function hexOf(deviceId: DeviceId): string {
  return [...deviceId]
    .map((byte) => byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0"))
    .join("");
}

/** A resolved AsyncIterable yielding nothing, for a fake MeshSession's own events/revocationAnnouncements streams: neither is exercised by these tests. An object literal implementing Symbol.asyncIterator directly, not an async generator function, since this workspace's own lint rules forbid an empty generator body. */
function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<T>> =>
          Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}

// Mints a capability token authorizing webrtc:signal over a node-kind scope, self-issued and self-bearing: exactly the shape webrtc-signaling.unit.test.ts's own authorizeIncomingOffer tests already establish is sufficient.
async function mintAuthorizingToken(
  identity: IdentityPort,
  bearer: DeviceId,
): Promise<CapabilityToken> {
  const claims = {
    "token-id": Uint8Array.from([1]),
    issuer: identity.deviceId,
    "issuer-key": identity.identityKey,
    bearer,
    capability: WEBRTC_SIGNAL_VERB,
    scope: WEBRTC_SIGNAL_SCOPE,
    expires: Date.now() + HOUR_MS,
  };
  const payload = Uint8Array.from(encode(claims, cdeEncodeOptions));
  const protectedHeader = Uint8Array.from(encode({}, cdeEncodeOptions));
  const toBeSigned = Uint8Array.from(
    encode(
      ["Signature1", protectedHeader, new Uint8Array(0), payload],
      cdeEncodeOptions,
    ),
  );
  const signature = await identity.sign(toBeSigned);
  return [protectedHeader, {}, payload, signature];
}

interface FakeSession {
  session: MeshSession;
  /** Pushes an IncomingManageRequest as though it arrived over the wire, then immediately ends the stream: every test here sends exactly one request per session before moving on. */
  pushAndEnd: (request: IncomingManageRequest) => void;
  /** Every command this session's own sendManageRequest was called with, in call order. */
  sent: ManageCommand[];
}

function createFakeSession(): FakeSession {
  let resolveNext: ((request: IncomingManageRequest | null) => void) | null =
    null;
  const nextRequest = new Promise<IncomingManageRequest | null>((resolve) => {
    resolveNext = resolve;
  });
  const sent: ManageCommand[] = [];

  const incomingManageRequests: AsyncIterable<IncomingManageRequest> = {
    [Symbol.asyncIterator]() {
      let delivered = false;
      return {
        async next(): Promise<IteratorResult<IncomingManageRequest>> {
          if (delivered) {
            return { value: undefined, done: true };
          }
          delivered = true;
          const request = await nextRequest;
          return request === null
            ? { value: undefined, done: true }
            : { value: request, done: false };
        },
      };
    },
  };

  const session: MeshSession = {
    events: emptyAsyncIterable(),
    incomingManageRequests,
    revocationAnnouncements: emptyAsyncIterable(),
    connect: async (): Promise<void> =>
      Promise.reject(new Error("not used in these tests")),
    sendPing: async (): Promise<void> => Promise.resolve(),
    setToken: () => undefined,
    sendRevocationAnnounce: async (): Promise<void> => Promise.resolve(),
    sendGossipUpdate: async (): Promise<void> => Promise.resolve(),
    sendDataFrame: async (): Promise<void> => Promise.resolve(),
    sendManageRequest: async (command): Promise<ManageOutcome> => {
      sent.push(command);
      return Promise.resolve({ result: "ok" });
    },
    close: async (): Promise<void> => Promise.resolve(),
  };

  return {
    session,
    pushAndEnd: (request) => {
      resolveNext?.(request);
    },
    sent,
  };
}

function fakeIncomingOffer(
  negotiationId: number,
  sdp: string,
  token: CapabilityToken | undefined,
  respond: (outcome: ManageOutcome) => Promise<void>,
): IncomingManageRequest {
  return {
    requestId: negotiationId,
    command: buildOfferCommand(negotiationId, sdp),
    scope: WEBRTC_SIGNAL_SCOPE,
    ...(token !== undefined ? { token } : {}),
    respond,
  };
}

function createFakeBackend(
  joinResult: JoinResult,
): SfuMediaBackend & { joinedParticipantIds: string[] } {
  const joinedParticipantIds: string[] = [];
  return {
    joinedParticipantIds,
    async join(participantId): Promise<JoinResult> {
      joinedParticipantIds.push(participantId);
      return Promise.resolve(joinResult);
    },
    // Not exercised by these tests: see media-backend.ts's own doc comment for why a real backend may legitimately no-op this too.
    addIceCandidate: async (): Promise<void> => Promise.resolve(),
    leave: async (): Promise<readonly string[]> => Promise.resolve([]),
  };
}

describe("createSfuCall", () => {
  it("rejects an offer with no token as unauthorized, never reaching the backend", async () => {
    const backend = createFakeBackend({
      answerSdp: "unused",
      produced: [],
      consumed: [],
    });
    const call = createSfuCall(backend, {
      identity: await generateIdentity(),
      clock: { now: () => Date.now() },
      revocation: neverRevoked,
    });
    const fake = createFakeSession();
    const responses: ManageOutcome[] = [];
    const addParticipant = call.addParticipant(
      deviceIdFromFillByte(DEVICE_A_FILL_BYTE),
      fake.session,
    );
    fake.pushAndEnd(
      fakeIncomingOffer(
        NEGOTIATION_ID_B_JOINS_FIRST,
        "v=0",
        undefined,
        async (outcome): Promise<void> => {
          responses.push(outcome);
          return Promise.resolve();
        },
      ),
    );
    await addParticipant;
    expect(responses).toEqual([{ result: "error", code: "unauthorized" }]);
    expect(fake.sent).toEqual([]);
    expect(backend.joinedParticipantIds).toEqual([]);
  });

  it("answers an authorized offer via the backend, addressing the backend by the offerer's own hex device-id", async () => {
    const deviceA = deviceIdFromFillByte(DEVICE_A_FILL_BYTE);
    const identity = await generateIdentity();
    const backend = createFakeBackend({
      answerSdp: "v=0 answer",
      produced: [{ mid: "0", kind: "audio" } satisfies BackendTrack],
      consumed: [],
    });
    const call = createSfuCall(backend, {
      identity,
      clock: { now: () => Date.now() },
      revocation: neverRevoked,
    });
    const fake = createFakeSession();
    const addParticipant = call.addParticipant(deviceA, fake.session);
    const token = await mintAuthorizingToken(identity, deviceA);
    const responses: ManageOutcome[] = [];
    fake.pushAndEnd(
      fakeIncomingOffer(
        NEGOTIATION_ID_AUTHORIZED_OFFER,
        "v=0 offer",
        token,
        async (outcome): Promise<void> => {
          responses.push(outcome);
          return Promise.resolve();
        },
      ),
    );
    await addParticipant;

    expect(backend.joinedParticipantIds).toEqual([hexOf(deviceA)]);
    expect(responses).toEqual([{ result: "ok" }]);
    expect(fake.sent).toEqual([
      {
        verb: WEBRTC_SIGNAL_VERB,
        params: {
          verb: "webrtc.answer",
          "negotiation-id": NEGOTIATION_ID_AUTHORIZED_OFFER,
          sdp: "v=0 answer",
        },
      },
    ]);
  });

  it("sends the joining participant its own first sfu-track-map when the backend reports consumed tracks", async () => {
    const deviceA = deviceIdFromFillByte(DEVICE_A_FILL_BYTE);
    const deviceB = deviceIdFromFillByte(DEVICE_B_FILL_BYTE);
    const identity = await generateIdentity();
    const call = createSfuCall(
      createFakeBackend({
        answerSdp: "v=0 answer",
        produced: [],
        consumed: [
          {
            mid: "2",
            kind: "video",
            fromParticipantId: hexOf(deviceB),
          },
        ],
      }),
      { identity, clock: { now: () => Date.now() }, revocation: neverRevoked },
    );

    // deviceB is already an established participant before deviceA joins, so the backend's own "consumed from deviceB" report can be attributed back to a real, known device-id.
    const sessionB = createFakeSession();
    const joinB = call.addParticipant(deviceB, sessionB.session);
    const tokenB = await mintAuthorizingToken(identity, deviceB);
    sessionB.pushAndEnd(
      fakeIncomingOffer(
        NEGOTIATION_ID_B_JOINS_FIRST,
        "v=0 offer B",
        tokenB,
        async (): Promise<void> => Promise.resolve(),
      ),
    );
    await joinB;

    const sessionA = createFakeSession();
    const joinA = call.addParticipant(deviceA, sessionA.session);
    const tokenA = await mintAuthorizingToken(identity, deviceA);
    sessionA.pushAndEnd(
      fakeIncomingOffer(
        NEGOTIATION_ID_A_JOINS_SECOND,
        "v=0 offer A",
        tokenA,
        async (): Promise<void> => Promise.resolve(),
      ),
    );
    await joinA;

    const trackMapCommands = sessionA.sent.filter(
      (command) =>
        typeof command.params === "object" &&
        "verb" in command.params &&
        command.params.verb === "webrtc.sfu-track-map",
    );
    expect(trackMapCommands).toEqual([
      {
        verb: WEBRTC_SIGNAL_VERB,
        params: {
          verb: "webrtc.sfu-track-map",
          "negotiation-id": NEGOTIATION_ID_A_JOINS_SECOND,
          tracks: [{ mid: "2", member: deviceB, kind: "video" }],
        },
      },
    ]);
  });

  it("removeParticipant is idempotent for a participant never added", async () => {
    const backend = createFakeBackend({
      answerSdp: "unused",
      produced: [],
      consumed: [],
    });
    const call = createSfuCall(backend, {
      identity: await generateIdentity(),
      clock: { now: () => Date.now() },
      revocation: neverRevoked,
    });
    await expect(
      call.removeParticipant(deviceIdFromFillByte(DEVICE_C_FILL_BYTE)),
    ).resolves.toBeUndefined();
    expect(call.participantCount).toBe(0);
  });
});
