// The replaced channel opens frames that were in flight for one handshake window and no longer. The window is read again after the awaits of opening, so a frame whose opening took the clock past the window is refused even though the window had not passed when the open began (spec/secure-channel.cddl, obligation 9).

import { describe, expect, it } from "vitest";
import { HANDSHAKE_WINDOW_MS } from "../src/domain/relay-channels.js";
import {
  establish,
  TestRelay,
  useUnhandledRecorder,
} from "./relay-channels-harness.js";

const unhandled = useUnhandledRecorder();

describe("the replaced channel's window", () => {
  it("is read again after the open's awaits, so a frame that opened too late is refused", async () => {
    const relay = new TestRelay();
    const a = await relay.node("a");
    const b = await relay.node("b");
    await establish(a, b);
    const [inFlight] = await b.send(a, { type: "pong" }, "reply");
    if (inFlight === undefined) {
      throw new Error("no frame was sealed");
    }
    // b restarts and its first frame confirms a new channel at a, which makes the old one a replaced channel.
    const restarted = await relay.restart(b);
    const request = await restarted.send(a, { type: "ping" });
    await Promise.all(request.map(async (record) => a.receiveData(record)));

    // The clock reads inside the window when the open begins, and a whole window later when the open has waited for its decryption.
    const read = relay.clock.now;
    let reads = 0;
    relay.clock.now = () => {
      reads += 1;

      return reads === 1 ? read() : read() + HANDSHAKE_WINDOW_MS;
    };

    expect(await a.receiveData(inFlight)).toBeUndefined();
    expect(unhandled()).toEqual([]);
  });
});
