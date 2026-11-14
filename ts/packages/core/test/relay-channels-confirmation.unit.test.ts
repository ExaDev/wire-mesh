// A hello never replaces a channel by itself: it yields a candidate, and the candidate takes over only once a frame from the peer opens under it (spec/secure-channel.cddl, obligations 7 to 9). Each test drives two endpoints through a scripted relay that queues every hello and frame, counts the hellos each side sent, and checks which frames open.

import { describe, expect, it } from "vitest";
import { ChannelExhaustedError } from "../src/domain/channel-exhausted-error.js";
import {
  CANDIDATES_PER_HANDSHAKE,
  HANDSHAKE_WINDOW_MS,
} from "../src/domain/relay-channels.js";
import { MAX_COUNTER } from "../src/domain/secure-channel.js";
import type { Frame } from "../src/generated/protocol.js";
import {
  establish,
  freshHello,
  TestRelay,
  useUnhandledRecorder,
  type HelloRecord,
  type Node,
} from "./relay-channels-harness.js";
import { repeatInSequence } from "./sequence.js";

const ping: Frame = { type: "ping" };
const pong: Frame = { type: "pong" };
const PAST_WINDOW_MS = HANDSHAKE_WINDOW_MS + 1;
const REPLAY_WINDOWS = 10;
const BEFORE_WINDOW_MS = HANDSHAKE_WINDOW_MS - 1;

const unhandled = useUnhandledRecorder();

async function pair(): Promise<{ relay: TestRelay; a: Node; b: Node }> {
  const relay = new TestRelay();
  const a = await relay.node("a");
  const b = await relay.node("b");

  return { relay, a, b };
}

function first(records: readonly HelloRecord[]): HelloRecord {
  const [record] = records;
  if (record === undefined) {
    throw new Error("no hello was sent");
  }

  return record;
}

/** Both carry a frame to the other and the other opens it. */
async function carriesFrames(a: Node, b: Node): Promise<void> {
  const toB = await a.send(b, ping);
  const atB = await Promise.all(
    toB.map(async (record) => b.receiveData(record)),
  );
  expect(atB.filter((opened) => opened !== undefined)).toHaveLength(1);
  const toA = await b.send(a, pong, "reply");
  const atA = await Promise.all(
    toA.map(async (record) => a.receiveData(record)),
  );
  expect(atA.filter((opened) => opened !== undefined)).toHaveLength(1);
}

describe("a hello that repeats one already held", () => {
  it("is dropped when it is the current channel's, sending nothing", async () => {
    const { relay, a, b } = await pair();
    await establish(a, b);
    const sentA = a.hellosSent.length;
    const sentB = b.hellosSent.length;

    await a.receiveHello(first(b.hellosSent).hello, b.deviceId);
    await b.receiveHello(first(a.hellosSent).hello, a.deviceId);
    await relay.idle();

    expect(a.hellosSent).toHaveLength(sentA);
    expect(b.hellosSent).toHaveLength(sentB);
    await carriesFrames(a, b);
    expect(unhandled()).toEqual([]);
  });

  it("is dropped when the relay duplicates a hello of a handshake still in progress", async () => {
    const { relay, a, b } = await pair();
    const sealing = a.beginSend(b, ping);
    const [helloA] = await relay.take();
    if (helloA === undefined) {
      throw new Error("no hello was queued");
    }
    await relay.deliver(helloA);
    const [helloB] = await relay.take();
    if (helloB === undefined) {
      throw new Error("no answer was queued");
    }
    await relay.deliver(helloB);
    await sealing;

    await relay.deliver(helloA);
    await relay.deliver(helloB);
    await relay.deliver(helloB);

    expect(a.hellosSent).toHaveLength(1);
    expect(b.hellosSent).toHaveLength(1);
    expect(unhandled()).toEqual([]);
  });
});

describe("an older hello replayed to a side that holds a channel", () => {
  it("costs one hello from each side, and the channel both keep sealing under is unchanged", async () => {
    const { relay, a, b } = await pair();
    await establish(a, b);
    const older = first(b.hellosSent);
    a.forget(b);
    b.forget(a);
    await establish(a, b);
    const sentA = a.hellosSent.length;
    const sentB = b.hellosSent.length;

    await relay.deliver(older);
    await relay.pump();

    expect(a.hellosSent).toHaveLength(sentA + 1);
    expect(b.hellosSent).toHaveLength(sentB + 1);
    await carriesFrames(a, b);

    relay.clock.advance(PAST_WINDOW_MS);
    await carriesFrames(a, b);
    expect(a.hellosSent).toHaveLength(sentA + 1);
    expect(b.hellosSent).toHaveLength(sentB + 1);
    expect(unhandled()).toEqual([]);
  });

  it("costs each side at most one hello per window, however often it is replayed", async () => {
    const { relay, a, b } = await pair();
    await establish(a, b);
    const older = first(b.hellosSent);
    a.forget(b);
    b.forget(a);
    await establish(a, b);

    await repeatInSequence(REPLAY_WINDOWS, async () => {
      const sentA = a.hellosSent.length;
      const sentB = b.hellosSent.length;
      await relay.deliver(older);
      await relay.deliver(older);
      await relay.pump();
      expect(a.hellosSent.length - sentA).toBeLessThanOrEqual(1);
      expect(b.hellosSent.length - sentB).toBeLessThanOrEqual(1);
      relay.clock.advance(PAST_WINDOW_MS);
    });
    await carriesFrames(a, b);
    expect(unhandled()).toEqual([]);
  });
});

describe("two sides that initiate at once", () => {
  const orders = [
    { name: "a's hello first", aFirst: true, twice: false },
    { name: "b's hello first", aFirst: false, twice: false },
    {
      name: "a's hello first, each delivered twice",
      aFirst: true,
      twice: true,
    },
    {
      name: "b's hello first, each delivered twice",
      aFirst: false,
      twice: true,
    },
  ];

  for (const { name, aFirst, twice } of orders) {
    it(`reach the same channel with one hello each, ${name}`, async () => {
      const { relay, a, b } = await pair();
      const fromA = a.beginSend(b, ping);
      const fromB = b.beginSend(a, pong);
      const queued = await relay.take(2);
      const ordered = aFirst ? queued : [...queued].reverse();
      await repeatInSequence(twice ? 2 : 1, async () => {
        await repeatInSequence(ordered.length, async (index) => {
          const record = ordered[index];
          if (record !== undefined) {
            await relay.deliver(record);
          }
        });
      });

      const [toB, toA] = await Promise.all([fromA, fromB]);
      expect(a.hellosSent).toHaveLength(1);
      expect(b.hellosSent).toHaveLength(1);
      const atB = await Promise.all(toB.map(async (r) => b.receiveData(r)));
      const atA = await Promise.all(toA.map(async (r) => a.receiveData(r)));
      expect(atB.filter((opened) => opened !== undefined)).toHaveLength(1);
      expect(atA.filter((opened) => opened !== undefined)).toHaveLength(1);
      await carriesFrames(a, b);
      expect(unhandled()).toEqual([]);
    });
  }
});

describe("a peer that restarts", () => {
  it("with a request to send costs two hellos, and its first frame confirms the new channel", async () => {
    const { relay, a, b } = await pair();
    await establish(a, b);
    const inFlightSoon = await b.send(a, ping);
    relay.clock.advance(1);
    const inFlightLate = await b.send(a, ping);
    const sentA = a.hellosSent.length;
    const restarted = await relay.restart(b);

    const request = await restarted.send(a, ping);
    const opened = await Promise.all(
      request.map(async (record) => a.receiveData(record)),
    );

    expect(opened.filter((frame) => frame !== undefined)).toHaveLength(1);
    expect(restarted.hellosSent).toHaveLength(1);
    expect(a.hellosSent).toHaveLength(sentA + 1);
    // Frames sealed under the replaced channel before the switch still open for a window, and no longer.
    const [soon] = inFlightSoon;
    const [late] = inFlightLate;
    if (soon === undefined || late === undefined) {
      throw new Error("no frame was sealed");
    }
    expect(await a.receiveData(soon)).toBeDefined();
    relay.clock.advance(PAST_WINDOW_MS);
    expect(await a.receiveData(late)).toBeUndefined();
    expect(unhandled()).toEqual([]);
  });

  it("with nothing to send costs no hello until the survivor forgets it and sends, then two", async () => {
    const { relay, a, b } = await pair();
    await establish(a, b);
    const sentA = a.hellosSent.length;
    const restarted = await relay.restart(b);
    expect(restarted.hellosSent).toHaveLength(0);

    const lost = await a.send(restarted, ping);
    expect(
      await Promise.all(lost.map(async (r) => restarted.receiveData(r))),
    ).toEqual([undefined]);
    expect(a.hellosSent).toHaveLength(sentA);

    a.forget(restarted);
    await carriesFrames(a, restarted);
    expect(a.hellosSent).toHaveLength(sentA + 1);
    expect(restarted.hellosSent).toHaveLength(1);
    expect(unhandled()).toEqual([]);
  });
});

describe("a channel whose send counter is spent", () => {
  it("is replaced by a handshake that costs two hellos, and the next frame confirms it", async () => {
    const relay = new TestRelay();
    const a = await relay.node("a", { firstSendCounter: MAX_COUNTER });
    const b = await relay.node("b");
    await establish(a, b);
    const sentA = a.hellosSent.length;
    const sentB = b.hellosSent.length;
    await expect(a.send(b, ping)).rejects.toThrow(ChannelExhaustedError);

    const next = await a.send(b, ping);
    const opened = await Promise.all(next.map(async (r) => b.receiveData(r)));

    expect(opened.filter((frame) => frame !== undefined)).toHaveLength(1);
    expect(a.hellosSent).toHaveLength(sentA + 1);
    expect(b.hellosSent).toHaveLength(sentB + 1);
    expect(unhandled()).toEqual([]);
  });
});

describe("a relay that holds or reorders", () => {
  it("answers a delayed answer with at most one further hello from each side", async () => {
    const { relay, a, b } = await pair();
    const sealing = a.beginSend(b, ping);
    const [helloA] = await relay.take();
    if (helloA === undefined) {
      throw new Error("no hello was queued");
    }
    await relay.deliver(helloA);
    const [answer] = await relay.take();
    if (answer === undefined) {
      throw new Error("no answer was queued");
    }
    relay.clock.advance(PAST_WINDOW_MS);
    await relay.deliver(answer);
    await relay.pump();

    await sealing;
    expect(a.hellosSent.length).toBeLessThanOrEqual(2);
    expect(b.hellosSent.length).toBeLessThanOrEqual(2);
    // A request sealed while both candidates are held reaches the peer under exactly one of them.
    const copies = await a.send(b, ping);
    const opened = await Promise.all(copies.map(async (r) => b.receiveData(r)));
    expect(opened.filter((frame) => frame !== undefined)).toHaveLength(1);
    expect(unhandled()).toEqual([]);
  });

  it("drops a frame that arrives before its hello, and the resent frame opens with no extra hello", async () => {
    const { relay, a, b } = await pair();
    const sealing = a.beginSend(b, ping);
    const [helloA] = await relay.take();
    if (helloA === undefined) {
      throw new Error("no hello was queued");
    }
    await relay.deliver(helloA);
    const [answer] = await relay.take();
    if (answer === undefined) {
      throw new Error("no answer was queued");
    }
    const early = await b.send(a, pong, "reply");
    const [earlyFrame] = early;
    if (earlyFrame === undefined) {
      throw new Error("no frame was sealed");
    }
    expect(await a.receiveData(earlyFrame)).toBeUndefined();

    await relay.deliver(answer);
    await sealing;
    const resent = await b.send(a, pong, "reply");
    const opened = await Promise.all(resent.map(async (r) => a.receiveData(r)));

    expect(opened.filter((frame) => frame !== undefined)).toHaveLength(1);
    expect(a.hellosSent).toHaveLength(1);
    expect(b.hellosSent).toHaveLength(1);
    expect(unhandled()).toEqual([]);
  });

  it("drops a third hello in one handshake", async () => {
    const { relay, a, b } = await pair();
    const sealing = a.beginSend(b, ping);
    await relay.take();
    const stamped = b.deviceId;
    await a.receiveHello(await freshHello(b.identity, a), stamped);
    await a.receiveHello(await freshHello(b.identity, a), stamped);
    await a.receiveHello(await freshHello(b.identity, a), stamped);

    await sealing;
    // Only the first two hellos became candidates, so a frame sealed now has two copies, not three.
    expect(await a.beginSend(b, ping)).toHaveLength(CANDIDATES_PER_HANDSHAKE);
    expect(a.hellosSent).toHaveLength(1);
    expect(unhandled()).toEqual([]);
  });

  it("keeps the window's edge exact: a handshake is outstanding just inside it and over just outside", async () => {
    const { relay, a, b } = await pair();
    await establish(a, b);
    const older = first(b.hellosSent);
    a.forget(b);
    b.forget(a);
    await establish(a, b);
    await relay.deliver(older);
    const sent = a.hellosSent.length;

    // Its handshake with b is still outstanding just inside the window, so a second replay is completed, not answered.
    relay.clock.advance(BEFORE_WINDOW_MS);
    const otherOlder = await freshHello(b.identity, a);
    await a.receiveHello(otherOlder, b.deviceId);
    await relay.idle();
    expect(a.hellosSent).toHaveLength(sent);

    relay.clock.advance(2);
    await a.receiveHello(await freshHello(b.identity, a), b.deviceId);
    await relay.idle();
    expect(a.hellosSent).toHaveLength(sent + 1);
    expect(unhandled()).toEqual([]);
  });
});
