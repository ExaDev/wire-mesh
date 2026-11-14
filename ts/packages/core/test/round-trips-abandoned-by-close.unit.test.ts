// A promise created for a round trip (a ping, a manage-request) that a close can abandon is handled from its creation: the close is an expected outcome, the caller sees it as a rejection of what it awaits, and nothing is left as an unhandled rejection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMeshSession } from "../src/domain/mesh-session.js";
import { createPingRoundTrips } from "../src/domain/ping-round-trips.js";
import type { ManageCommand } from "../src/generated/protocol.js";
import {
  fakeTransport,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";

const PONG_TIMEOUT_MS = 60_000;
const SENT_AT = 1;
const PONG_ROUND_TRIP_MS = 7;

const unhandled: unknown[] = [];
function recordUnhandled(reason: unknown): void {
  unhandled.push(reason);
}

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", recordUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", recordUnhandled);
});

/** Lets Node report any rejection nothing handled: it does so after the microtask queue drains, on the next turn of the event loop. */
async function letUnhandledRejectionsSurface(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

const command: ManageCommand = {
  verb: "exec:proc",
  params: { verb: "exec.list" },
};

async function connected(): Promise<{
  session: ReturnType<typeof createMeshSession>;
  connection: ReturnType<typeof fakeTransport>["connection"];
}> {
  const { transport, connection } = fakeTransport();
  const session = createMeshSession(transport, testIdentity, testClock);
  await session.connect("ws://node", ["core/management"]);

  return { session, connection };
}

describe("a ping abandoned by a close", () => {
  it("is rejected to its caller, with nothing unhandled, when the close comes while the ping is still being sent", async () => {
    const { session, connection } = await connected();
    connection.holdSends();

    const ping = session.sendPingMeasureRtt(PONG_TIMEOUT_MS);
    const outcome = expect(ping).rejects.toThrow(/closed before a pong/);
    await vi.waitFor(() => {
      expect(connection.heldSendCount).toBeGreaterThan(0);
    });
    await session.close();
    // The close has settled the round trip while its send is still in flight; Node reports a rejection nothing handles on the next turn of the event loop, before the send is let go.
    await letUnhandledRejectionsSurface();
    expect(unhandled).toEqual([]);
    connection.releaseSends();
    await outcome;
  });

  it("is rejected to its caller, with nothing unhandled, when sending it fails and the close comes after", async () => {
    const trips = createPingRoundTrips();

    const ping = trips.sendAndAwait(SENT_AT, async () =>
      Promise.reject(new Error("the link refused the ping")),
    );
    await expect(ping).rejects.toThrow("the link refused the ping");
    trips.rejectAll("connection closed before a pong arrived");
    await letUnhandledRejectionsSurface();

    expect(unhandled).toEqual([]);
  });
});

describe("a ping whose send fails", () => {
  it("leaves no registration behind, so the next ping is paired with its own pong", async () => {
    const trips = createPingRoundTrips();

    await expect(
      trips.sendAndAwait(SENT_AT, async () =>
        Promise.reject(new Error("the link refused the ping")),
      ),
    ).rejects.toThrow("the link refused the ping");
    const next = trips.sendAndAwait(SENT_AT, async () => Promise.resolve());
    trips.resolveOldest(SENT_AT + PONG_ROUND_TRIP_MS);

    await expect(next).resolves.toBe(PONG_ROUND_TRIP_MS);
  });

  it("raises nothing unhandled when the session closes afterwards", async () => {
    const { session, connection } = await connected();
    connection.rejectSends(new Error("the link refused the ping"));

    await expect(session.sendPingMeasureRtt(PONG_TIMEOUT_MS)).rejects.toThrow(
      "the link refused the ping",
    );
    await session.close();
    await letUnhandledRejectionsSurface();

    expect(unhandled).toEqual([]);
  });
});

describe("a ping that is answered", () => {
  it("leaves no timeout timer running", async () => {
    vi.useFakeTimers();
    try {
      const trips = createPingRoundTrips();
      const ping = trips.sendAndAwait(
        SENT_AT,
        async () => Promise.resolve(),
        PONG_TIMEOUT_MS,
      );
      await vi.advanceTimersByTimeAsync(0);
      trips.resolveOldest(SENT_AT + PONG_ROUND_TRIP_MS);
      await ping;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a manage-request abandoned by a close", () => {
  it("is rejected to its caller, with nothing unhandled, when the close comes while the request is still being sent", async () => {
    const { session, connection } = await connected();
    connection.holdSends();

    const request = session.sendManageRequest(command, { kind: "folder" });
    const outcome = expect(request).rejects.toThrow(/closed before a response/);
    await vi.waitFor(() => {
      expect(connection.heldSendCount).toBeGreaterThan(0);
    });
    await session.close();
    // The close has settled the round trip while its send is still in flight; Node reports a rejection nothing handles on the next turn of the event loop, before the send is let go.
    await letUnhandledRejectionsSurface();
    expect(unhandled).toEqual([]);
    connection.releaseSends();
    await outcome;
  });

  it("raises nothing unhandled when sending it fails and the session closes afterwards", async () => {
    const { session, connection } = await connected();
    connection.rejectSends(new Error("the link refused the request"));

    await expect(
      session.sendManageRequest(command, { kind: "folder" }),
    ).rejects.toThrow("the link refused the request");
    await session.close();
    await letUnhandledRejectionsSurface();

    expect(unhandled).toEqual([]);
  });
});
