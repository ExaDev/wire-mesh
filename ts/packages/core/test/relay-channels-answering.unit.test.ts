// Failures and refusals while answering a hello beside an established channel leave that channel alone and tell the peer nothing, and a side holding the previous release's rule still interoperates (spec/secure-channel.cddl, obligations 8 to 10).

import { describe, expect, it } from "vitest";
import { helloSigningInput } from "../src/domain/secure-channel.js";
import { beginHandshake } from "../src/domain/secure-channel.js";
import type { Frame, SecureHelloFrame } from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import {
  establish,
  freshHello,
  TestRelay,
  useUnhandledRecorder,
  type Node,
} from "./relay-channels-harness.js";
import { generateEd25519Identity } from "./tokens-fixtures.js";

const ping: Frame = { type: "ping" };
const pong: Frame = { type: "pong" };
const P256_POINT_BYTES = 65;
const SEC1_UNCOMPRESSED = 4;

const unhandled = useUnhandledRecorder();

async function carries(from: Node, to: Node, frame: Frame): Promise<boolean> {
  const sealed = await from.send(to, frame, "reply");
  const opened = await Promise.all(
    sealed.map(async (record) => to.receiveData(record)),
  );

  return opened.some((result) => result !== undefined);
}

async function helloWithUnusableKey(
  signer: IdentityPort,
  to: Node,
): Promise<SecureHelloFrame> {
  const { hello } = await beginHandshake(signer, to.deviceId);
  const ephemeralKey = new Uint8Array(P256_POINT_BYTES).fill(1);
  ephemeralKey[0] = SEC1_UNCOMPRESSED;

  return {
    ...hello,
    "ephemeral-key": ephemeralKey,
    signature: await signer.sign(
      helloSigningInput(
        ephemeralKey,
        hello.nonce,
        signer.deviceId,
        to.deviceId,
      ),
    ),
  };
}

describe("a hello that cannot be used, beside an established channel", () => {
  it("with an unusable ephemeral key is dropped before any key of this side's own is generated, and changes nothing", async () => {
    const relay = new TestRelay();
    const base = await generateEd25519Identity();
    let generated = 0;
    const a = await relay.node("a", {
      identity: base,
      newHandshake: async (peer) => {
        generated += 1;

        return beginHandshake(base, peer);
      },
    });
    const b = await relay.node("b");
    await establish(a, b);
    const keysBefore = generated;
    const sent = a.hellosSent.length;

    await a.receiveHello(await helloWithUnusableKey(b.identity, a), b.deviceId);
    await relay.idle();

    expect(generated).toBe(keysBefore);
    expect(a.hellosSent).toHaveLength(sent);
    expect(await carries(a, b, ping)).toBe(true);
    expect(await carries(b, a, pong)).toBe(true);
    expect(unhandled()).toEqual([]);
  });

  it("whose answer cannot be sent leaves the channel in place and is reported", async () => {
    const relay = new TestRelay();
    const faults: unknown[] = [];
    const a = await relay.node("a", {
      onFault: (error) => {
        faults.push(error);
      },
    });
    const b = await relay.node("b");
    await establish(a, b);
    a.failSends = true;

    await a.receiveHello(await freshHello(b.identity, a), b.deviceId);
    await relay.idle();
    a.failSends = false;

    expect(faults).toHaveLength(1);
    expect(await carries(a, b, ping)).toBe(true);
    expect(await carries(b, a, pong)).toBe(true);
    expect(unhandled()).toEqual([]);
  });

  it("whose answer cannot be signed leaves the channel in place and is reported", async () => {
    const relay = new TestRelay();
    const faults: unknown[] = [];
    const a = await relay.node("a", {
      onFault: (error) => {
        faults.push(error);
      },
    });
    const b = await relay.node("b");
    await establish(a, b);
    a.failSigning = true;

    await a.receiveHello(await freshHello(b.identity, a), b.deviceId);
    await relay.idle();
    a.failSigning = false;

    expect(faults).toHaveLength(1);
    expect(await carries(a, b, ping)).toBe(true);
    expect(await carries(b, a, pong)).toBe(true);
    expect(unhandled()).toEqual([]);
  });

  it("stamped with another device is dropped before its signature is checked", async () => {
    const relay = new TestRelay();
    const base = await generateEd25519Identity();
    let verified = 0;
    const counting: IdentityPort = {
      ...base,
      verify: async (key, data, signature) => {
        verified += 1;

        return base.verify(key, data, signature);
      },
    };
    const a = await relay.node("a", { identity: counting });
    const b = await relay.node("b");
    const c = await relay.node("c");
    await establish(a, b);
    const verifiedBefore = verified;
    const sent = a.hellosSent.length;

    await a.receiveHello(await freshHello(b.identity, a), c.deviceId);
    await a.receiveHello(await freshHello(b.identity, a), undefined);
    await relay.idle();

    expect(verified).toBe(verifiedBefore);
    expect(a.hellosSent).toHaveLength(sent);
    expect(unhandled()).toEqual([]);
  });
});

describe("a side that holds the previous release's rule", () => {
  it("answers an older replayed hello, and its next frame confirms the new channel", async () => {
    const relay = new TestRelay();
    const a = await relay.node("a");
    const released = await relay.node("released", { kind: "released" });
    await establish(a, released);
    const older = released.hellosSent[0];
    if (older === undefined) {
      throw new Error("no hello was sent");
    }
    a.forget(released);
    await establish(a, released);
    const sentA = a.hellosSent.length;
    const sentReleased = released.hellosSent.length;

    await relay.deliver(older);
    await relay.pump();

    expect(a.hellosSent).toHaveLength(sentA + 1);
    expect(released.hellosSent).toHaveLength(sentReleased + 1);
    // The released side switched channel when it answered, so its next frame is sealed under the new one.
    const next = await released.send(a, pong);
    const opened = await Promise.all(next.map(async (r) => a.receiveData(r)));
    expect(opened.filter((result) => result !== undefined)).toHaveLength(1);
    expect(unhandled()).toEqual([]);
  });

  it("is met again after a request to it is lost and forgotten, because the candidate survives the forget", async () => {
    const relay = new TestRelay();
    const a = await relay.node("a");
    const released = await relay.node("released", { kind: "released" });
    await establish(a, released);
    const older = released.hellosSent[0];
    if (older === undefined) {
      throw new Error("no hello was sent");
    }
    a.forget(released);
    await establish(a, released);
    await relay.deliver(older);
    await relay.pump();

    // The released side has switched channel: a request sealed under the old one is lost.
    const lost = await a.send(released, ping);
    const received = await Promise.all(
      lost.map(async (record) => released.receiveData(record)),
    );
    expect(received.filter((result) => result !== undefined)).toEqual([]);
    // The request times out, and the session forgets the peer.
    a.forget(released);

    // The released side's next request, sealed under the channel it switched to, opens under the candidate the forget kept and confirms it; then requests go both ways.
    expect(await carries(released, a, pong)).toBe(true);
    expect(await carries(a, released, ping)).toBe(true);
    expect(unhandled()).toEqual([]);
  });

  it("opens a channel with a new side in both directions", async () => {
    const relay = new TestRelay();
    const a = await relay.node("a");
    const released = await relay.node("released", { kind: "released" });

    await establish(a, released);

    expect(await carries(a, released, ping)).toBe(true);
    expect(await carries(released, a, pong)).toBe(true);
    expect(unhandled()).toEqual([]);
  });
});
