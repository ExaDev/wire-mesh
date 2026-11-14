// Peers this side chose are never displaced by hellos from peers it did not choose, whose entries are bounded (spec/secure-channel.cddl, obligations 8 and 9).

import { describe, expect, it } from "vitest";
import {
  HANDSHAKE_WINDOW_MS,
  MAX_UNSOLICITED_PEERS,
} from "../src/domain/relay-channels.js";
import { beginHandshake } from "../src/domain/secure-channel.js";
import type { Frame } from "../src/generated/protocol.js";
import {
  establish,
  TestRelay,
  useUnhandledRecorder,
  type Node,
} from "./relay-channels-harness.js";
import { repeatInSequence } from "./sequence.js";
import { generateEd25519Identity } from "./tokens-fixtures.js";

const ping: Frame = { type: "ping" };
const pong: Frame = { type: "pong" };
const PAST_WINDOW_MS = HANDSHAKE_WINDOW_MS + 1;
const FLOOD_TIMEOUT_MS = 60_000;

const unhandled = useUnhandledRecorder();

async function hello(
  from: Awaited<ReturnType<typeof generateEd25519Identity>>,
  to: Node,
) {
  return (await beginHandshake(from, to.deviceId)).hello;
}

async function carries(from: Node, to: Node, frame: Frame): Promise<boolean> {
  const sealed = await from.send(to, frame, "reply");
  const opened = await Promise.all(
    sealed.map(async (record) => to.receiveData(record)),
  );

  return opened.some((result) => result !== undefined);
}

describe("hellos from identities this side never chose", () => {
  it(
    "are answered only up to the unsolicited limit within a window, and never displace a chosen peer",
    async () => {
      const relay = new TestRelay();
      const a = await relay.node("a");
      const chosen = await relay.node("chosen");
      await establish(a, chosen);
      const sent = a.hellosSent.length;

      await repeatInSequence(2 * MAX_UNSOLICITED_PEERS, async () => {
        const stranger = await generateEd25519Identity();
        await a.receiveHello(await hello(stranger, a), stranger.deviceId);
      });
      await relay.idle();

      // Each answer needs a free entry, and an entry younger than the window is never reused, and none of these is the chosen peer's.
      expect(a.hellosSent.length - sent).toBeLessThanOrEqual(
        MAX_UNSOLICITED_PEERS,
      );
      expect(await carries(a, chosen, ping)).toBe(true);
      expect(await carries(chosen, a, pong)).toBe(true);
      expect(unhandled()).toEqual([]);
    },
    FLOOD_TIMEOUT_MS,
  );

  it(
    "make room, once old enough, only at the expense of peers that were never chosen",
    async () => {
      const relay = new TestRelay();
      const a = await relay.node("a");
      const replied = await relay.node("replied");
      const requested = await relay.node("requested");
      // `replied` opens a channel by sending first, so this side only ever replies to it; `requested` is one this side sends a request to.
      await establish(replied, a);
      await establish(a, requested);
      await a.send(replied, pong, "reply");
      relay.clock.advance(PAST_WINDOW_MS);

      await repeatInSequence(MAX_UNSOLICITED_PEERS, async () => {
        const stranger = await generateEd25519Identity();
        await a.receiveHello(await hello(stranger, a), stranger.deviceId);
      });
      await relay.idle();

      expect(await carries(a, requested, ping)).toBe(true);
      expect(await carries(requested, a, pong)).toBe(true);
      // The peer this side only replied to was evicted to make room.
      const sealed = await replied.send(a, ping);
      const opened = await Promise.all(
        sealed.map(async (record) => a.receiveData(record)),
      );
      expect(opened.some((result) => result !== undefined)).toBe(false);
      expect(unhandled()).toEqual([]);
    },
    FLOOD_TIMEOUT_MS,
  );
});
