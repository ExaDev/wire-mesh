// Failures local to this side are reported to the owner at a bounded rate, and a failing callback never ends anything.

import { describe, expect, it, vi } from "vitest";
import { HANDSHAKE_WINDOW_MS } from "../src/domain/relay-channels.js";
import type { DeviceId } from "../src/generated/protocol.js";
import {
  flush,
  freshHello,
  TestRelay,
  useUnhandledRecorder,
} from "./relay-channels-harness.js";
import { repeatInSequence } from "./sequence.js";

const PAST_WINDOW_MS = HANDSHAKE_WINDOW_MS + 1;
const FAILURES = 5;

const unhandled = useUnhandledRecorder();

describe("local fault reports", () => {
  it("are one per peer per window, and the next one says how many were withheld", async () => {
    const relay = new TestRelay();
    const reports: { peer: DeviceId | undefined; suppressed: number }[] = [];
    const a = await relay.node("a", {
      onFault: (_error, context) => {
        reports.push(context);
      },
    });
    const b = await relay.node("b");
    a.failSigning = true;

    await repeatInSequence(FAILURES, async () => {
      await a.receiveHello(await freshHello(b.identity, a), b.deviceId);
    });
    await flush();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.suppressed).toBe(0);

    relay.clock.advance(PAST_WINDOW_MS);
    await a.receiveHello(await freshHello(b.identity, a), b.deviceId);
    await flush();
    expect(reports).toHaveLength(2);
    expect(reports[1]?.suppressed).toBe(FAILURES - 1);
    expect(unhandled()).toEqual([]);
  });

  it("go to a callback that rejects without an unhandled rejection, reported once to the console", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const relay = new TestRelay();
    const a = await relay.node("a", {
      onFault: async () => Promise.reject(new Error("the callback rejected")),
    });
    const b = await relay.node("b");
    a.failSigning = true;

    await a.receiveHello(await freshHello(b.identity, a), b.deviceId);
    await flush();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(unhandled()).toEqual([]);
    consoleError.mockRestore();
  });
});
