// The shared rule for consuming a session's incoming streams: a failure while handling one item is contained to it, reported once, and the loop goes on; nothing rejects to whoever started the loop.

import { describe, expect, it, vi } from "vitest";
import {
  HANDLER_FAILED_OUTCOME,
  consumeEach,
  serveManageRequests,
} from "../src/domain/consume-incoming.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "../src/domain/mesh-session.js";
import { createAsyncQueue } from "../src/domain/async-queue.js";

const FIRST = 1;
const SECOND = 2;
const THIRD = 3;

/** A stream of `values` that then ends, or that throws `error` instead of ending. */
function streamOf<T>(values: readonly T[], error?: Error): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;

      return {
        next: async (): Promise<IteratorResult<T>> => {
          const value = values[index];
          index += 1;
          if (index <= values.length && value !== undefined) {
            return Promise.resolve({ value, done: false });
          }
          if (error !== undefined) {
            return Promise.reject(error);
          }

          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function items(...values: readonly number[]): AsyncIterable<number> {
  return streamOf(values);
}

function request(
  requestId: number,
  respond: IncomingManageRequest["respond"],
): IncomingManageRequest {
  return {
    requestId,
    command: { verb: "exec:proc", params: { verb: "exec.list" } },
    scope: { kind: "folder" },
    respond,
  };
}

describe("consumeEach", () => {
  it("handles every item in order and resolves when the stream ends", async () => {
    const seen: number[] = [];

    await consumeEach(items(FIRST, SECOND, THIRD), (item) => {
      seen.push(item);
    });

    expect(seen).toEqual([FIRST, SECOND, THIRD]);
  });

  it("reports a failing item once with that item and goes on to the next", async () => {
    const seen: number[] = [];
    const faults: [unknown, number | undefined][] = [];

    await consumeEach(
      items(FIRST, SECOND, THIRD),
      async (item) => {
        if (item === SECOND) throw new Error("the second failed");
        seen.push(item);

        return Promise.resolve();
      },
      {
        onFault: (error, item) => {
          faults.push([error, item]);
        },
      },
    );

    expect(seen).toEqual([FIRST, THIRD]);
    expect(faults).toHaveLength(1);
    expect(faults[0]?.[1]).toBe(SECOND);
  });

  it("ends cleanly, reporting once with no item, when the stream itself fails", async () => {
    const failing = streamOf([FIRST], new Error("the session went away"));
    const faults: (number | undefined)[] = [];

    await expect(
      consumeEach(failing, () => undefined, {
        onFault: (_error, item) => {
          faults.push(item);
        },
      }),
    ).resolves.toBeUndefined();

    expect(faults).toEqual([undefined]);
  });

  it("is not ended by a fault listener that throws", async () => {
    const seen: number[] = [];

    await consumeEach(
      items(FIRST, SECOND),
      (item) => {
        seen.push(item);
        throw new Error("always fails");
      },
      {
        onFault: () => {
          throw new Error("the listener fails too");
        },
      },
    );

    expect(seen).toEqual([FIRST, SECOND]);
  });

  it("never rejects, with no listener at all", async () => {
    await expect(
      consumeEach(items(FIRST), () => {
        throw new Error("dropped");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("serveManageRequests", () => {
  it("answers a request whose handling failed before it was answered with a refusal, and serves the next", async () => {
    const queue = createAsyncQueue<IncomingManageRequest>();
    const answers: [number, ManageOutcome][] = [];
    const respond =
      (requestId: number): IncomingManageRequest["respond"] =>
      async (outcome) => {
        answers.push([requestId, outcome]);

        return Promise.resolve();
      };
    const faults: unknown[] = [];
    const served = vi.fn();
    void serveManageRequests(
      queue.stream,
      async (incoming) => {
        if (incoming.requestId === FIRST) throw new Error("handler failed");
        served(incoming.requestId);
        await incoming.respond({ result: "ok" });
      },
      {
        onFault: (error) => {
          faults.push(error);
        },
      },
    );

    queue.push(request(FIRST, respond(FIRST)));
    queue.push(request(SECOND, respond(SECOND)));
    await vi.waitFor(() => {
      expect(answers).toHaveLength(2);
    });

    expect(answers).toEqual([
      [FIRST, HANDLER_FAILED_OUTCOME],
      [SECOND, { result: "ok" }],
    ]);
    expect(served).toHaveBeenCalledWith(SECOND);
    expect(faults).toHaveLength(1);
  });

  it("does not answer again a request the handler already answered", async () => {
    const answers: ManageOutcome[] = [];

    await serveManageRequests(
      requestsOf(
        request(FIRST, async (outcome) => {
          answers.push(outcome);

          return Promise.resolve();
        }),
      ),
      async (incoming) => {
        await incoming.respond({ result: "ok" });
        throw new Error("failed after answering");
      },
    );

    expect(answers).toEqual([{ result: "ok" }]);
  });

  it("drops the request, still reporting once, when the refusal cannot be sent either", async () => {
    const faults: unknown[] = [];

    await serveManageRequests(
      requestsOf(
        request(FIRST, async () => Promise.reject(new Error("link down"))),
      ),
      async () => Promise.reject(new Error("handler failed")),
      {
        onFault: (error) => {
          faults.push(error);
        },
      },
    );

    expect(faults).toHaveLength(1);
  });
});

function requestsOf(
  ...values: readonly IncomingManageRequest[]
): AsyncIterable<IncomingManageRequest> {
  return streamOf(values);
}
