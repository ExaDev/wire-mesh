// Two sides that open at once agree on one channel without either answering the other (spec/secure-channel.cddl), and hellos that overlap leave no handshake behind.

import { describe, expect, it } from "vitest";
import {
  createRelayChannels,
  type RelayChannels,
} from "../src/domain/relay-channels.js";
import type {
  DeviceId,
  Frame,
  SecureHelloFrame,
} from "../src/generated/protocol.js";
import { beginHandshake } from "../src/domain/secure-channel.js";
import { generateEd25519Identity } from "./tokens-fixtures.js";

const ping: Frame = { type: "ping" };
const SETTLE_MS = 20;

describe("hellos that cross", () => {
  it("converge on one channel each, with one hello sent by each side", async () => {
    const a = await generateEd25519Identity();
    const b = await generateEd25519Identity();
    const queue: { to: "a" | "b"; hello: SecureHelloFrame }[] = [];
    const sent: Record<"a" | "b", DeviceId[]> = { a: [], b: [] };
    const relays: { a?: RelayChannels; b?: RelayChannels } = {};
    relays.a = createRelayChannels(a, async (peer, hello) => {
      sent.a.push(peer);
      queue.push({ to: "b", hello });

      return Promise.resolve();
    });
    relays.b = createRelayChannels(b, async (peer, hello) => {
      sent.b.push(peer);
      queue.push({ to: "a", hello });

      return Promise.resolve();
    });
    const atA = relays.a;
    const atB = relays.b;

    // Both start before either hello is delivered.
    const fromA = atA.ensure(b.deviceId);
    const fromB = atB.ensure(a.deviceId);
    await new Promise((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
    await Promise.all(
      queue
        .splice(0)
        .map(async ({ to, hello }) =>
          (to === "a" ? atA : atB).applyHello(hello),
        ),
    );
    const [channelA, channelB] = await Promise.all([fromA, fromB]);

    expect(queue).toEqual([]);
    expect(sent.a).toHaveLength(1);
    expect(sent.b).toHaveLength(1);
    expect(await atB.open(await channelA.seal(ping), a.deviceId)).toMatchObject(
      { frame: ping },
    );
    expect(await atA.open(await channelB.seal(ping), b.deviceId)).toMatchObject(
      { frame: ping },
    );
  });
});

describe("two hellos from a peer that overlap while a channel with it is established", () => {
  it("leave one established channel and no handshake waiting", async () => {
    const local = await generateEd25519Identity();
    const peer = await generateEd25519Identity();
    const links: { peer?: RelayChannels } = {};
    // Hellos reach the peer only while it is being set up: afterwards the overlap is the hellos applied below.
    let wired = true;
    const atLocal = createRelayChannels(local, async (_to, hello) =>
      wired ? links.peer?.applyHello(hello) : undefined,
    );
    const atPeer = createRelayChannels(peer, async (_to, hello) =>
      atLocal.applyHello(hello),
    );
    links.peer = atPeer;
    await atLocal.ensure(peer.deviceId);
    wired = false;

    const first = await beginHandshake(peer, local.deviceId);
    const second = await beginHandshake(peer, local.deviceId);
    await Promise.all([
      atLocal.applyHello(first.hello),
      atLocal.applyHello(second.hello),
    ]);

    // Anything left waiting would make this resolve late or never; an established channel resolves at once.
    const channel = await Promise.race([
      atLocal.ensure(peer.deviceId),
      new Promise<undefined>((resolve) => {
        setTimeout(resolve, SETTLE_MS);
      }),
    ]);
    expect(channel).toBeDefined();
    expect(await channel?.seal(ping)).toMatchObject({ type: "secure-data" });
  });
});
