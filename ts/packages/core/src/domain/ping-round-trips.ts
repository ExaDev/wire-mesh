// FIFO pairing between sendPingMeasureRtt calls and the pong-frames that answer them (wire-mesh#181) -- ping-frame/pong-frame carry no correlation id of their own (spec/transport.cddl), so the Nth outstanding call is paired against the Nth pong a connection receives. Extracted out of mesh-session.ts the same way relay-pairing.ts already extracts its own relay-pairing bookkeeping, so mesh-session.ts's own applyFrame/sendPingMeasureRtt stay thin wiring rather than owning this queue's mechanics directly.

interface PendingPingRoundTrip {
  sentAt: number;
  resolve: (rttMs: number) => void;
  reject: (error: Error) => void;
}

export interface PingRoundTrips {
  /** Resolves the oldest still-pending call with (nowMs - itsOwnSentAt) -- called once per pong-frame received. A no-op if nothing is pending (a stray pong with no outstanding call). */
  resolveOldest: (nowMs: number) => void;
  /** Rejects and clears every still-pending call -- called on disconnect. */
  rejectAll: (reason: string) => void;
  /**
   * Registers sentAt, awaits sendPing (the caller's own "build the ping-frame, log it, transmit it, emit" sequence -- mesh-session.ts's own concern, not this module's), then resolves once resolveOldest/rejectAll settles the registration, racing an optional timeoutMs that cancels the registration and rejects instead of leaving it to resolve later against a pong that arrives after giving up.
   */
  sendAndAwait: (
    sentAt: number,
    sendPing: () => Promise<void>,
    timeoutMs?: number,
  ) => Promise<number>;
}

export function createPingRoundTrips(): PingRoundTrips {
  const pending: PendingPingRoundTrip[] = [];

  function cancel(sentAt: number): boolean {
    const index = pending.findIndex((entry) => entry.sentAt === sentAt);
    if (index === -1) {
      return false;
    }
    pending.splice(index, 1);
    return true;
  }

  return {
    resolveOldest(nowMs: number): void {
      const entry = pending.shift();
      if (entry !== undefined) {
        entry.resolve(nowMs - entry.sentAt);
      }
    },
    rejectAll(reason: string): void {
      for (const entry of pending.splice(0)) {
        entry.reject(new Error(reason));
      }
    },
    async sendAndAwait(sentAt, sendPing, timeoutMs): Promise<number> {
      const rtt = new Promise<number>((resolve, reject) => {
        pending.push({ sentAt, resolve, reject });
      });
      await sendPing();
      if (timeoutMs === undefined) {
        return rtt;
      }
      return Promise.race([
        rtt,
        new Promise<number>((_resolve, reject) => {
          setTimeout(() => {
            if (cancel(sentAt)) {
              reject(new Error("timed out waiting for pong"));
            }
          }, timeoutMs);
        }),
      ]);
    },
  };
}
