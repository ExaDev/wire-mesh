// Splits one session's stream of incoming manage-requests by verb. A session's stream has a single backlog, so two consumers reading it race for each request and either can take one meant for the other. A hub connection needs more than one: the WebRTC negotiator answers webrtc:signal, and the conversations reached through that hub answer the room verbs. This is the one reader; each consumer gets a stream of just its own verb.

import { createAsyncQueue } from "wire-mesh-core/domain/async-queue";
import type { AsyncQueue } from "wire-mesh-core/domain/async-queue";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";

export interface RequestDemux {
  /** The requests carrying `verb`, in arrival order. Only the verbs the demux was built with have a stream. */
  stream: (verb: string) => AsyncIterable<IncomingManageRequest>;
}

/**
 * Starts reading `source` and delivers each request to the stream of its verb. A request for a verb not listed in `verbs` has no consumer and is dropped, which is what happens to it today: nothing in this package answers a verb it does not speak.
 */
export function createRequestDemux(
  source: Readonly<AsyncIterable<IncomingManageRequest>>,
  verbs: readonly string[],
): RequestDemux {
  const queues = new Map<string, AsyncQueue<IncomingManageRequest>>(
    verbs.map((verb) => [verb, createAsyncQueue<IncomingManageRequest>()]),
  );
  void (async () => {
    for await (const request of source) {
      queues.get(request.command.verb)?.push(request);
    }
  })();

  return {
    stream: (verb) => {
      const queue = queues.get(verb);
      if (queue === undefined) {
        throw new Error(`the demux was not built to carry verb ${verb}`);
      }

      return queue.stream;
    },
  };
}
