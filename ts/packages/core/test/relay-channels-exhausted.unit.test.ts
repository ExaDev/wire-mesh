// A channel whose send counter is spent is dropped, so the next send to that peer starts a new handshake instead of failing for good.

import { describe, expect, it } from "vitest";
import { ChannelExhaustedError } from "../src/domain/channel-exhausted-error.js";
import { createRelayChannels } from "../src/domain/relay-channels.js";
import {
  MAX_COUNTER,
} from "../src/domain/secure-channel.js";
import type { Frame } from "../src/generated/protocol.js";
import { generateEd25519Identity } from "./tokens-fixtures.js";

const ping: Frame = { type: "ping" };

describe("a channel whose send counter is spent", () => {
  it("is forgotten, and the next ensure opens a fresh one that the peer accepts", async () => {
    const a = await generateEd25519Identity();
    const b = await generateEd25519Identity();
    const relays: {
      a?: ReturnType<typeof createRelayChannels>;
      b?: ReturnType<typeof createRelayChannels>;
    } = {};
    relays.a = createRelayChannels(
      a,
      async (_peer, hello) => relays.b?.applyHello(hello),
      { firstSendCounter: MAX_COUNTER },
    );
    relays.b = createRelayChannels(b, async (_peer, hello) =>
      relays.a?.applyHello(hello),
    );
    const fromA = relays.a;
    const atB = relays.b;

    const first = await fromA.ensure(b.deviceId);
    const last = await first.seal(ping);
    expect(last.counter).toBe(MAX_COUNTER);
    expect(await atB.open(last, a.deviceId)).toMatchObject({ frame: ping });
    await expect(first.seal(ping)).rejects.toThrow(ChannelExhaustedError);

    const second = await fromA.ensure(b.deviceId);
    expect(second).not.toBe(first);
    const sealed = await second.seal(ping);
    expect(sealed.counter).toBe(MAX_COUNTER);
    expect(await atB.open(sealed, a.deviceId)).toMatchObject({ frame: ping });
  });
});
