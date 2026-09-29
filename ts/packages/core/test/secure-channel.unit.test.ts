import { describe, expect, it } from "vitest";
import { buildCapabilityRequestCommand } from "../src/domain/capability-request.js";
import {
  beginHandshake,
  establishChannel,
  verifyHello,
  type SecureChannel,
} from "../src/domain/secure-channel.js";
import type {
  Frame,
  SecureDataFrame,
  SecureHelloFrame,
} from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import {
  generateEd25519Identity,
  generateEs256Identity,
  LOW_BYTE_MASK,
} from "./tokens-fixtures.js";

const CONCURRENT_FRAME_COUNT = 24;
const P256_UNCOMPRESSED_POINT_BYTE_LENGTH = 65;

const request: Frame = {
  type: "manage-request",
  "request-id": 1,
  command: buildCapabilityRequestCommand("room:member"),
  scope: { kind: "node" },
};

/** Runs a whole handshake between two identities, as it happens when each side answers the other's hello, and returns the channel each ends up with. */
async function connect(
  a: Readonly<IdentityPort>,
  b: Readonly<IdentityPort>,
): Promise<{ atA: SecureChannel; atB: SecureChannel }> {
  const pendingA = await beginHandshake(a, b.deviceId);
  const pendingB = await beginHandshake(b, a.deviceId);
  const helloAtB = await verifyHello(b, pendingA.hello);
  const helloAtA = await verifyHello(a, pendingB.hello);
  if (!helloAtA.ok || !helloAtB.ok) throw new Error("hello refused");
  const atA = await establishChannel(
    a,
    pendingA,
    pendingB.hello,
    helloAtA.peer,
  );
  const atB = await establishChannel(
    b,
    pendingB,
    pendingA.hello,
    helloAtB.peer,
  );
  if (atA === undefined || atB === undefined) throw new Error("no channel");
  return { atA, atB };
}

function flipFirstByte(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = Uint8Array.from(bytes);
  copy[0] = (copy[0] ?? 0) ^ LOW_BYTE_MASK;
  return copy;
}

describe("the handshake", () => {
  it("gives both ends a channel that carries frames in both directions, whichever device-id sorts first", async () => {
    const one = await generateEd25519Identity();
    const two = await generateEs256Identity();

    for (const [a, b] of [
      [one, two],
      [two, one],
    ] as const) {
      const { atA, atB } = await connect(a, b);

      expect(await atB.open(await atA.seal(request))).toEqual(request);
      expect(await atA.open(await atB.seal(request))).toEqual(request);
    }
  });

  it("names the peer by the device-id its own identity key hashes to", async () => {
    const a = await generateEd25519Identity();
    const b = await generateEs256Identity();

    const { atA, atB } = await connect(a, b);

    expect(atA.peer.deviceId).toEqual(b.deviceId);
    expect(atB.peer.deviceId).toEqual(a.deviceId);
  });

  it("produces a hello that verifies for its recipient", async () => {
    const a = await generateEd25519Identity();
    const b = await generateEd25519Identity();
    const pending = await beginHandshake(a, b.deviceId);

    expect(await verifyHello(b, pending.hello)).toMatchObject({ ok: true });
  });

  it("refuses a hello addressed to someone else", async () => {
    const a = await generateEd25519Identity();
    const b = await generateEd25519Identity();
    const c = await generateEd25519Identity();
    const forC = await beginHandshake(a, c.deviceId);

    expect(await verifyHello(b, forC.hello)).toEqual({
      ok: false,
      reason: "wrong_recipient",
    });
  });

  it("refuses a hello whose ephemeral key was swapped, since the signature covers it", async () => {
    const a = await generateEd25519Identity();
    const b = await generateEd25519Identity();
    const other = await beginHandshake(a, b.deviceId);
    const genuine = await beginHandshake(a, b.deviceId);
    const swapped: SecureHelloFrame = {
      ...genuine.hello,
      "ephemeral-key": other.hello["ephemeral-key"],
    };

    expect(await verifyHello(b, swapped)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a hello re-signed under a different identity key than the one it claims", async () => {
    const a = await generateEd25519Identity();
    const attacker = await generateEd25519Identity();
    const b = await generateEd25519Identity();
    const genuine = await beginHandshake(a, b.deviceId);
    const forged: SecureHelloFrame = {
      ...genuine.hello,
      "identity-key": attacker.identityKey,
    };

    const verdict = await verifyHello(b, forged);

    expect(verdict.ok).toBe(false);
  });

  it("refuses a hello with a corrupted signature", async () => {
    const a = await generateEd25519Identity();
    const b = await generateEd25519Identity();
    const genuine = await beginHandshake(a, b.deviceId);
    const corrupted: SecureHelloFrame = {
      ...genuine.hello,
      signature: flipFirstByte(genuine.hello.signature),
    };

    expect(await verifyHello(b, corrupted)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("gives no channel when the peer's ephemeral key is not a point on the curve", async () => {
    const a = await generateEd25519Identity();
    const b = await generateEd25519Identity();
    const pending = await beginHandshake(a, b.deviceId);
    const pendingB = await beginHandshake(b, a.deviceId);
    const bogus: SecureHelloFrame = {
      ...pendingB.hello,
      "ephemeral-key": new Uint8Array(P256_UNCOMPRESSED_POINT_BYTE_LENGTH),
    };

    const channel = await establishChannel(a, pending, bogus, {
      deviceId: b.deviceId,
      identityKey: b.identityKey,
    });

    expect(channel).toBeUndefined();
  });

  it("uses fresh keys for every handshake, so two channels between the same devices do not open each other's frames", async () => {
    const a = await generateEd25519Identity();
    const b = await generateEd25519Identity();
    const first = await connect(a, b);
    const second = await connect(a, b);

    expect(
      await second.atB.open(await first.atA.seal(request)),
    ).toBeUndefined();
  });
});

describe("a channel", () => {
  it("does not open a frame with the key it was sealed under, so a reflected frame is refused", async () => {
    const a = await generateEd25519Identity();
    const b = await generateEd25519Identity();
    const { atA } = await connect(a, b);

    expect(await atA.open(await atA.seal(request))).toBeUndefined();
  });

  it("refuses a frame it has already accepted", async () => {
    const { atA, atB } = await connect(
      await generateEd25519Identity(),
      await generateEd25519Identity(),
    );
    const sealed = await atA.seal(request);

    expect(await atB.open(sealed)).toEqual(request);
    expect(await atB.open(sealed)).toBeUndefined();
  });

  it("refuses a frame older than one it has accepted, but accepts a later one after a gap", async () => {
    const { atA, atB } = await connect(
      await generateEd25519Identity(),
      await generateEd25519Identity(),
    );
    const first = await atA.seal(request);
    const second = await atA.seal(request);
    const third = await atA.seal(request);

    expect(await atB.open(third)).toEqual(request);
    expect(await atB.open(first)).toBeUndefined();
    expect(await atB.open(second)).toBeUndefined();
  });

  it("refuses a frame whose ciphertext was altered", async () => {
    const { atA, atB } = await connect(
      await generateEd25519Identity(),
      await generateEd25519Identity(),
    );
    const sealed = await atA.seal(request);
    const altered: SecureDataFrame = {
      ...sealed,
      ciphertext: flipFirstByte(sealed.ciphertext),
    };

    expect(await atB.open(altered)).toBeUndefined();
  });

  it("refuses a frame whose counter was altered, since the counter is authenticated", async () => {
    const { atA, atB } = await connect(
      await generateEd25519Identity(),
      await generateEd25519Identity(),
    );
    const sealed = await atA.seal(request);

    expect(
      await atB.open({ ...sealed, counter: sealed.counter + 1 }),
    ).toBeUndefined();
  });

  it("does not let a forged frame move the counter past the real ones", async () => {
    const { atA, atB } = await connect(
      await generateEd25519Identity(),
      await generateEd25519Identity(),
    );
    const real = await atA.seal(request);

    await atB.open({
      type: "secure-data",
      counter: 500,
      ciphertext: real.ciphertext,
    });

    expect(await atB.open(real)).toEqual(request);
  });

  it("keeps counter order when many frames are sealed at once", async () => {
    const { atA, atB } = await connect(
      await generateEd25519Identity(),
      await generateEd25519Identity(),
    );

    const sealed = await Promise.all(
      Array.from({ length: CONCURRENT_FRAME_COUNT }, async () =>
        atA.seal(request),
      ),
    );

    expect(sealed.map((frame) => frame.counter)).toEqual(
      sealed.map((_frame, index) => index),
    );
    for (const frame of sealed) {
      expect(await atB.open(frame)).toEqual(request);
    }
  });

  it("does not put the frame's content in what it sends", async () => {
    const { atA } = await connect(
      await generateEd25519Identity(),
      await generateEd25519Identity(),
    );
    const secret: Frame = {
      type: "manage-request",
      "request-id": 2,
      command: buildCapabilityRequestCommand("room:member"),
      scope: { kind: "room", path: "a-recognisable-room-path" },
    };

    const sealed = await atA.seal(secret);

    expect(new TextDecoder("latin1").decode(sealed.ciphertext)).not.toContain(
      "a-recognisable-room-path",
    );
  });
});
