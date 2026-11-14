// Per-sender delivery for a multi-party ceremony: one value per device, awaited with a bound, failed as a whole, removing every registration it makes.

interface PendingWaiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** One (verb-family, session-id)'s worth of per-sender-device delivery: a message that arrives before anyone is waiting for it is buffered; a waiter that arrives before the message does is registered. Mirrors mesh-session.ts's own backlog/waiter pattern for its incomingManageRequests iterator, scoped down to "exactly one value per device-id" rather than an ordered stream. A wait settles on delivery, on `fail`, or after its own bound, and removes its registration whichever it is. */
export class PerDeviceCollector<T> {
  private readonly waiters = new Map<string, PendingWaiter<T>>();

  private readonly backlog = new Map<string, T>();

  private failure: Error | undefined;

  /** Resolves with the value `deviceHex` sends. Rejects when the collector is failed, when `timeoutMs` passes first (unbounded when absent), or at once when another wait for the same device is already registered, since a second wait would take the value the first needs. */
  async awaitFrom(deviceHex: string, timeoutMs?: number): Promise<T> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const buffered = this.backlog.get(deviceHex);
    if (buffered !== undefined) {
      this.backlog.delete(deviceHex);

      return buffered;
    }
    if (this.waiters.has(deviceHex)) {
      throw new Error(`a wait for ${deviceHex} is already registered`);
    }

    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.waiters.delete(deviceHex);
              reject(
                new Error(
                  `timed out waiting for ${deviceHex} to send its part of the ceremony`,
                ),
              );
            }, timeoutMs);
      this.waiters.set(deviceHex, { resolve, reject, timer });
    });
  }

  deliver(deviceHex: string, value: T): void {
    const waiter = this.waiters.get(deviceHex);
    if (waiter !== undefined) {
      this.waiters.delete(deviceHex);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else {
      this.backlog.set(deviceHex, value);
    }
  }

  /** Aborts every pending and future wait -- the ceremony failed for a reason no single awaitFrom call caused (a peer sent threshold.abort, the transcript did not match, the request stream ended). */
  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
