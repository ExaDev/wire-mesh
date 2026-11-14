/**
 * The one way to consume a session's incoming streams (incomingManageRequests, incomingDataFrames, revocationAnnouncements, coordinatorFrames, events, or any other async iterable of items): a failure while handling one item is contained to that item, reported once, and the loop goes on to the next, and no rejection escapes to whoever started the loop. A consumer written as a bare `for await` loop ends for good on the first item whose handling throws, and when it was started with `void` the rejection is unhandled, which ends a Node process by default.
 *
 * A failure of the stream itself (the iterator throws, as it does when the session behind it has gone) ends the loop and is reported once with no item. A stream that simply finishes ends the loop without a report.
 */

import type { IncomingManageRequest, ManageOutcome } from "./mesh-session.js";

/** What a consumer is told about a failure. `item` is the item whose handling failed, or undefined when the stream itself failed. */
export type ConsumeFault<T> = (error: unknown, item: T | undefined) => void;

export interface ConsumeOptions<T> {
  /** Told once per failure. A throw from this callback is ignored: reporting a fault never ends the loop either. Omit to drop failures silently. */
  onFault?: ConsumeFault<T> | undefined;
}

/**
 * Handles each item of `source` in order with `handle`. Resolves when the stream ends or fails, and never rejects.
 */
export async function consumeEach<T>(
  source: Readonly<AsyncIterable<T>>,
  handle: (item: T) => void | Promise<void>,
  options: Readonly<ConsumeOptions<T>> = {},
): Promise<void> {
  const report = (error: unknown, item: T | undefined): void => {
    try {
      options.onFault?.(error, item);
    } catch {
      // A listener that throws must not end the loop it is told about.
    }
  };
  try {
    for await (const item of source) {
      try {
        await handle(item);
      } catch (error) {
        report(error, item);
      }
    }
  } catch (error) {
    report(error, undefined);
  }
}

/** The refusal sent for a request whose handling failed before it was answered. */
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
    options,
  );
}
