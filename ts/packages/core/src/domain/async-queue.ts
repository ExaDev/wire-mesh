/** A backlog-plus-waiters async queue: push() delivers to whichever consumer is already waiting on next(), or buffers the value for a consumer that hasn't asked yet. mesh-session.ts used this exact pattern three times over (events, incomingManageRequests, revocationAnnouncements) with nothing session-shaped about it -- extracted here once new features kept pushing that file over this repo's own max-lines lint budget. Never ends on its own (matches every one of mesh-session.ts's own async iterables, none of which the session itself ever closes): a consumer stops by simply not calling next() again. */

export interface AsyncQueue<T> {
  /** Delivers value to whichever consumer's own next() call is already waiting, or buffers it for the next one that asks. */
  push: (value: T) => void;
  /** Every consumer obtaining `[Symbol.asyncIterator]()` shares this same queue's backlog/waiters -- concurrent consumers race for each pushed value exactly as they would over any other shared queue, matching mesh-session.ts's own pre-extraction behaviour. */
  readonly stream: AsyncIterable<T>;
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const waiters: ((value: T) => void)[] = [];
  const backlog: T[] = [];
  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(value);
      } else {
        backlog.push(value);
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<T>> =>
            new Promise((resolve) => {
              const backlogValue = backlog.shift();
              if (backlogValue !== undefined) {
                resolve({ value: backlogValue, done: false });
              } else {
                waiters.push((value) => {
                  resolve({ value, done: false });
                });
              }
            }),
        };
      },
    },
  };
}
