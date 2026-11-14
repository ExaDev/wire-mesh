// The shared rule for consuming a session's incoming streams: a failure while handling one item is contained to it, reported once, and the loop goes on; nothing rejects to whoever started the loop.

import { describe, expect, it, vi } from "vitest";
import { FAULT_REPORT_INTERVAL_MS } from "../src/domain/fault-report.js";
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
const ITEMS_PER_INTERVAL = 4;

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

describe("consumeEach, told to stop", () => {
  it("ends as soon as it is aborted, even while waiting for an item, and closes the stream's iterator", async () => {
    const stop = new AbortController();
    const seen: number[] = [];
    let closed = false;
    const queue = createAsyncQueue<number>();
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        const inner = queue.stream[Symbol.asyncIterator]();

        return {
          next: async () => inner.next(),
          return: async () => {
            closed = true;

            return inner.return?.() ?? { value: undefined, done: true };
          },
        };
      },
    };
    const done = consumeEach(
      source,
      (item) => {
        seen.push(item);
      },
      { signal: stop.signal },
    );

    queue.push(FIRST);
    await vi.waitFor(() => {
      expect(seen).toEqual([FIRST]);
    });
    stop.abort();
    await done;
    queue.push(SECOND);

    expect(seen).toEqual([FIRST]);
    expect(closed).toBe(true);
  });

  /** Two readers over one queue, the first stopped in the same turn as `arrange` leaves its items: every item is handled by exactly one of them, in order within each, and none is lost. */
  async function everyItemIsHandledOnce(
    arrange: (
      queue: ReturnType<typeof createAsyncQueue<number>>,
      stop: AbortController,
    ) => void,
  ): Promise<void> {
    const queue = createAsyncQueue<number>();
    const stop = new AbortController();
    const byFirst: number[] = [];
    const byLater: number[] = [];
    const first = consumeEach(
      queue.stream,
      (item) => {
        byFirst.push(item);
      },
      { signal: stop.signal },
    );
    arrange(queue, stop);
    await first;
    void consumeEach(queue.stream, (item) => {
      byLater.push(item);
    });

    await vi.waitFor(() => {
      expect([...byFirst, ...byLater].sort((a, b) => a - b)).toEqual([
        FIRST,
        SECOND,
        THIRD,
      ]);
    });
  }

  it("loses no item when the abort comes after items were already waiting in the queue", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(FIRST);
    queue.push(SECOND);
    queue.push(THIRD);
    const stop = new AbortController();
    const byFirst: number[] = [];
    const byLater: number[] = [];
    const first = consumeEach(
      queue.stream,
      (item) => {
        byFirst.push(item);
      },
      { signal: stop.signal },
    );
    stop.abort();
    await first;
    void consumeEach(queue.stream, (item) => {
      byLater.push(item);
    });

    await vi.waitFor(() => {
      expect([...byFirst, ...byLater].sort((a, b) => a - b)).toEqual([
        FIRST,
        SECOND,
        THIRD,
      ]);
    });
    expect(byFirst.length + byLater.length).toBe(THIRD);
  });

  it("loses no item when the abort comes in the same turn as a push to the waiting loop", async () => {
    await everyItemIsHandledOnce((queue, stop) => {
      queue.push(FIRST);
      stop.abort();
      queue.push(SECOND);
      queue.push(THIRD);
    });
  });

  it("loses no item when the abort comes before the pushes", async () => {
    await everyItemIsHandledOnce((queue, stop) => {
      stop.abort();
      queue.push(FIRST);
      queue.push(SECOND);
      queue.push(THIRD);
    });
  });

  it("finishes an item it has already taken before it stops", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(FIRST);
    const stop = new AbortController();
    const finished: number[] = [];
    const first = consumeEach(
      queue.stream,
      async (item) => {
        await Promise.resolve();
        finished.push(item);
      },
      { signal: stop.signal },
    );
    stop.abort();
    await first;

    expect(finished).toEqual([FIRST]);
  });
});

describe("consumeEach, told of the stream failing", () => {
  it("reports the failure even when an item failure was reported inside the same interval", async () => {
    const told: (number | undefined)[] = [];
    const failing = streamOf([FIRST], new Error("the session went away"));

    await consumeEach(
      failing,
      () => {
        throw new Error("the item fails");
      },
      {
        onFault: (_error, item) => {
          told.push(item);
        },
        now: () => 0,
      },
    );

    expect(told).toEqual([FIRST, undefined]);
  });
});

describe("a fault listener", () => {
  it("that returns a promise which rejects does not raise an unhandled rejection or end the loop", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    const reported = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const seen: number[] = [];
    try {
      await consumeEach(
        items(FIRST, SECOND),
        (item) => {
          seen.push(item);
          throw new Error("always fails");
        },
        {
          onFault: async () =>
            Promise.reject(new Error("the listener rejects")),
        },
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(unhandled).toEqual([]);
      expect(seen).toEqual([FIRST, SECOND]);
      expect(reported).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", record);
      reported.mockRestore();
    }
  });

  it("is told of one failure per source per interval, with the count it was not told of", async () => {
    let clock = 0;
    const told: [number | undefined, number][] = [];

    await consumeEach(
      items(FIRST, FIRST, FIRST, SECOND, FIRST),
      (item) => {
        if (item === FIRST) {
          clock += FAULT_REPORT_INTERVAL_MS / ITEMS_PER_INTERVAL;
        }
        throw new Error(`item ${String(item)} fails`);
      },
      {
        onFault: (_error, item, suppressed) => {
          told.push([item, suppressed]);
        },
        sourceOf: (item) => (item === SECOND ? "other" : "first"),
        now: () => clock,
      },
    );

    // The first failure is told at once; the next two in the same interval are counted; a failure from another source is told at once; the fifth falls in the same interval as the first, which has not yet passed.
    expect(told).toEqual([
      [FIRST, 0],
      [SECOND, 0],
    ]);
  });

  it("is told, after the interval, how many failures from that source it was not told of", async () => {
    let clock = 0;
    const told: number[] = [];
    const fail = (): never => {
      throw new Error("fails");
    };
    const options = {
      onFault: (_error: unknown, _item: unknown, suppressed: number): void => {
        told.push(suppressed);
      },
      now: () => clock,
    };
    const queue = createAsyncQueue<number>();
    const stop = new AbortController();
    const done = consumeEach(queue.stream, fail, {
      ...options,
      signal: stop.signal,
    });
    queue.push(FIRST);
    queue.push(FIRST);
    queue.push(FIRST);
    await vi.waitFor(() => {
      expect(told).toEqual([0]);
    });
    clock += FAULT_REPORT_INTERVAL_MS;
    queue.push(FIRST);
    await vi.waitFor(() => {
      expect(told).toEqual([0, 2]);
    });
    stop.abort();
    queue.push(FIRST);
    await done;
  });
});

describe("consumeEach, reporting a failure", () => {
  it("goes on to the next item when the caller's sourceOf throws", async () => {
    const seen: number[] = [];
    const reported = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await consumeEach(
        items(FIRST, SECOND, THIRD),
        (item) => {
          seen.push(item);
          throw new Error("the item fails");
        },
        {
          onFault: () => undefined,
          sourceOf: () => {
            throw new Error("the source cannot be named");
          },
        },
      );

      expect(seen).toEqual([FIRST, SECOND, THIRD]);
      expect(reported).toHaveBeenCalledTimes(THIRD);
    } finally {
      reported.mockRestore();
    }
  });

  it("goes on to the next item when the reporter's own clock throws", async () => {
    const seen: number[] = [];
    const reported = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await consumeEach(
        items(FIRST, SECOND),
        (item) => {
          seen.push(item);
          throw new Error("the item fails");
        },
        {
          onFault: () => undefined,
          now: () => {
            throw new Error("the clock failed");
          },
        },
      );

      expect(seen).toEqual([FIRST, SECOND]);
    } finally {
      reported.mockRestore();
    }
  });
});

describe("serveManageRequests", () => {
  it("never puts text from the failure in the refusal a requester receives", async () => {
    const answers: ManageOutcome[] = [];

    await serveManageRequests(
      requestsOf(
        request(FIRST, async (outcome) => {
          answers.push(outcome);

          return Promise.resolve();
        }),
      ),
      async () => Promise.reject(new Error("distinctive-internal-detail")),
    );

    expect(answers).toEqual([HANDLER_FAILED_OUTCOME]);
    expect(JSON.stringify(answers)).not.toContain(
      "distinctive-internal-detail",
    );
  });

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
