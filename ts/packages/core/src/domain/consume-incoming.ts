/**
 * The one way to consume a session's incoming streams (incomingManageRequests, incomingDataFrames, revocationAnnouncements, coordinatorFrames, events, or any other async iterable of items): a failure while handling one item is contained to that item, reported once, and the loop goes on to the next, and no rejection escapes to whoever started the loop. A consumer written as a bare `for await` loop ends for good on the first item whose handling throws, and when it was started with `void` the rejection is unhandled, which ends a Node process by default.
 *
 * A failure of the stream itself (the iterator throws, as it does when the session behind it has gone) ends the loop and is reported once with no item. A stream that simply finishes ends the loop without a report.
 */

import { deviceIdToHex } from "./device-id.js";
import { createFaultReporter } from "./fault-report.js";
import type { IncomingManageRequest, ManageOutcome } from "./mesh-session.js";

/** What a consumer is told about a failure. `item` is the item whose handling failed, or undefined when the stream itself failed. `suppressed` is how many failures from the same source were not reported since the previous report (see FAULT_REPORT_INTERVAL_MS). */
export type ConsumeFault<T> = (
  error: unknown,
  item: T | undefined,
  suppressed: number,
) => void | Promise<void>;

export interface ConsumeOptions<T> {
  /** Told of a failure, at most once per source per FAULT_REPORT_INTERVAL_MS, so a peer cannot drive one report per failing item. A throw from this callback, or a promise it returns that rejects, is reported once to the console and dropped: reporting a fault never ends the loop either. Omit to drop failures silently. */
  onFault?: ConsumeFault<T> | undefined;
  /** Names the source an item's failure is counted against, so that one peer's failures do not hide another's. Items share one source when omitted. */
  sourceOf?: ((item: T) => string) | undefined;
  /** Ends the loop when aborted, between items or while it waits for one, and closes the stream's iterator so no item it would have taken is lost to a later reader. An item being handled is finished first. */
  signal?: AbortSignal | undefined;
  /** The clock the report interval is read from. */
  now?: (() => number) | undefined;
}

/**
 * Handles each item of `source` in order with `handle`. Resolves when the stream ends or fails, and never rejects.
 */
export async function consumeEach<T>(
  source: Readonly<AsyncIterable<T>>,
  handle: (item: T) => void | Promise<void>,
  options: Readonly<ConsumeOptions<T>> = {},
): Promise<void> {
  const reporter = createFaultReporter(options.now);
  const report = (error: unknown, item: T | undefined): void => {
    const { onFault } = options;
    if (onFault === undefined) {
      return;
    }
    const origin = item === undefined ? "" : (options.sourceOf?.(item) ?? "");
    reporter(origin, async (suppressed) => onFault(error, item, suppressed));
  };
  const iterator = source[Symbol.asyncIterator]();
  let closing: Promise<unknown> | undefined;
  // Closing the iterator withdraws the wait it holds on the stream, so it is done the moment the signal aborts: an item that arrives later belongs to the stream's next reader.
  const close = (): void => {
    closing ??= iterator.return?.().catch((error: unknown) => {
      report(error, undefined);
    });
  };
  const stopped = new Promise<undefined>((resolve) => {
    options.signal?.addEventListener(
      "abort",
      () => {
        close();
        resolve(undefined);
      },
      { once: true },
    );
  });
  // An object property, so the compiler does not narrow it to `false` where the steps below flip it.
  const state = { finished: false };

  /** Takes and handles one item. Resolves true when there may be another, false when the stream ended or the loop was stopped; rejects when the stream itself failed. */
  async function step(): Promise<boolean> {
    if (options.signal?.aborted === true) {
      return false;
    }
    const pending = iterator.next();
    // An abandoned wait that later fails is the iterator's own business once it has been told to stop.
    pending.catch(() => undefined);
    const result = await Promise.race([pending, stopped]);
    if (result === undefined) {
      return false;
    }
    if (result.done === true) {
      state.finished = true;

      return false;
    }
    try {
      await handle(result.value);
    } catch (error) {
      report(error, result.value);
    }

    return true;
  }

  // One item at a time, in order, which is what a consumer of a stream relies on; the next step starts from the previous one's settlement, so a long-lived loop holds no chain of pending promises.
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      step().then(
        (more) => {
          if (more) {
            pump();
          } else {
            resolve();
          }
        },
        (error: unknown) => {
          state.finished = true;
          report(error, undefined);
          resolve();
        },
      );
    };
    pump();
  });
  if (!state.finished) {
    close();
  }
  await closing;
}

/** The refusal sent for a request whose handling failed before it was answered. It is a fixed code with no text from the failure, so a peer learns nothing of this side's internals; the code is this repository's convention for it, beside the codes a handler itself answers with. */
export const HANDLER_FAILED_OUTCOME: ManageOutcome = {
  result: "error",
  code: "internal-error",
};

/**
 * consumeEach for incoming manage-requests. A request whose handling fails before it was answered is answered with `internal-error`, so its sender is not left waiting for a response that will never come; if that answer cannot be sent either (the connection has gone), the request is dropped, and either way the failure is reported once. A request the handler already answered is not answered again.
 */
export async function serveManageRequests(
  source: Readonly<AsyncIterable<IncomingManageRequest>>,
  handle: (incoming: IncomingManageRequest) => Promise<void>,
  options: Readonly<ConsumeOptions<IncomingManageRequest>> = {},
): Promise<void> {
  await consumeEach(
    source,
    async (incoming) => {
      const state = { answered: false };
      const tracked: IncomingManageRequest = {
        ...incoming,
        respond: async (outcome) => {
          state.answered = true;
          await incoming.respond(outcome);
        },
      };
      try {
        await handle(tracked);
      } catch (error) {
        if (!state.answered) {
          await incoming.respond(HANDLER_FAILED_OUTCOME).catch(() => undefined);
        }
        throw error;
      }
    },
    {
      ...options,
      sourceOf:
        options.sourceOf ??
        ((incoming) =>
          incoming.fromDevice === undefined
            ? ""
            : deviceIdToHex(incoming.fromDevice)),
    },
  );
}
