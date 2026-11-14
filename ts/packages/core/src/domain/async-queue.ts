/** A backlog-plus-waiters async queue: push() delivers to whichever consumer is already waiting on next(), or buffers the value for a consumer that hasn't asked yet. mesh-session.ts used this exact pattern three times over (events, incomingManageRequests, revocationAnnouncements) with nothing session-shaped about it -- extracted here once new features kept pushing that file over this repo's own max-lines lint budget. Never ends on its own (matches every one of mesh-session.ts's own async iterables, none of which the session itself ever closes): a consumer stops by calling return() on its iterator, which also withdraws a next() it has waiting. */

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
        let finished = false;
        // The releases of every next() this iterator has waiting, so a return() withdraws all of them.
        const releases = new Set<() => void>();

        return {
          next: async (): Promise<IteratorResult<T>> =>
            new Promise((resolve) => {
              if (finished) {
                resolve({ value: undefined, done: true });

                return;
              }
              const backlogValue = backlog.shift();
              if (backlogValue !== undefined) {
                resolve({ value: backlogValue, done: false });

                return;
              }
              // The two are each other's cleanup: delivering withdraws the release, and releasing withdraws the waiter.
              const registration: { release?: () => void } = {};
              const waiter = (value: T): void => {
                if (registration.release !== undefined) {
                  releases.delete(registration.release);
                }
                resolve({ value, done: false });
              };
              registration.release = (): void => {
                waiters.splice(waiters.indexOf(waiter), 1);
                resolve({ value: undefined, done: true });
              };
              waiters.push(waiter);
              releases.add(registration.release);
            }),
          // Ends this iterator: every next() it has waiting stops being one of the waiters a push can wake, so a consumer that has stopped reading takes no value another reader needs. A value already handed to a next() stays with it.
          return: async (): Promise<IteratorResult<T>> => {
            finished = true;
            for (const release of [...releases]) {
              releases.delete(release);
              release();
            }

            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  };
}
