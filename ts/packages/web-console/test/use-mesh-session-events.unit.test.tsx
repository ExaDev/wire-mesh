// @vitest-environment jsdom

import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createAsyncQueue } from "wire-mesh-core/domain/async-queue";
import type { SessionEvent } from "wire-mesh-core/domain/mesh-session";
import { eachInOrder } from "../src/in-order.js";
import { useMeshSessionEvents } from "../src/hooks/use-mesh-session-events.js";

const EVENT_COUNT = 6;

function eventNumber(index: number): SessionEvent {
  return {
    state: {
      status: "connecting",
      address: `ws://node-${String(index)}`,
    },
    directory: [],
    frameLog: [],
  };
}

describe("useMeshSessionEvents", () => {
  afterEach(cleanup);

  it("delivers every event to the live effect after an effect that was cancelled before any arrived", async () => {
    const queue = createAsyncQueue<SessionEvent>();
    const session = { events: queue.stream };
    const clock = { now: () => 0 };
    // StrictMode mounts the effect, cleans it up and mounts it again on the same session, as the app does.
    const { result } = renderHook(() => useMeshSessionEvents(session, clock), {
      wrapper: StrictMode,
    });

    const events = Array.from({ length: EVENT_COUNT }, (_, index) =>
      eventNumber(index + 1),
    );
    // One at a time: each must reach the reader before the next is sent.
    await eachInOrder(events, async (event) => {
      await act(async () => {
        queue.push(event);
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(result.current.event).toBe(event);
      });
    });
  });
});
