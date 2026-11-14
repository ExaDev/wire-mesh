// A deterministic "everything pushed so far has been handled" signal for tests that drive a MeshSession through a FakeConnection. A session applies the frames of a connection one at a time and announces each once it has been applied, so a frame with a unique request-id that the session reports as received means every frame pushed before it has been applied. Tests wait on this instead of sleeping for a fixed time.

import { vi } from "vitest";
import type { createMeshSession } from "../src/domain/mesh-session.js";
import type { Frame } from "../src/generated/protocol.js";

const FIRST_BARRIER_ID = 1_000_000;
const POLL_INTERVAL_MS = 1;
const WAIT_TIMEOUT_MS = 5_000;

export interface SessionWatch {
  /** The connection state after every event the session has announced. */
  readonly states: string[];
  /** Resolves once every frame pushed before the call has been applied by the session. */
  barrier: () => Promise<void>;
}

/** Starts consuming `session.events` (a session's events have one consumer, so a test that needs both the states and the barrier asks this for both). */
export function watchSession(
  session: ReturnType<typeof createMeshSession>,
  push: (frame: Frame) => void,
): SessionWatch {
  const states: string[] = [];
  const seen = new Set<number>();
  let next = FIRST_BARRIER_ID;
  void (async (): Promise<void> => {
    for await (const event of session.events) {
      states.push(event.state.status);
      for (const entry of event.frameLog) {
        if (
          entry.direction === "received" &&
          entry.frame.type === "manage-response"
        ) {
          seen.add(entry.frame["request-id"]);
        }
      }
    }
  })();

  return {
    states,
    barrier: async () => {
      const id = next;
      next += 1;
      push({
        type: "manage-response",
        "request-id": id,
        outcome: { result: "ok" },
      });
      await vi.waitFor(
        () => {
          if (!seen.has(id)) {
            throw new Error("the session has not applied the frame yet");
          }
        },
        { interval: POLL_INTERVAL_MS, timeout: WAIT_TIMEOUT_MS },
      );
    },
  };
}
