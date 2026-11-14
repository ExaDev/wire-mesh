// FIFO pairing between sendPingMeasureRtt calls and the pong-frames that answer them (wire-mesh#181). ping-frame and pong-frame carry no correlation id of their own (spec/transport.cddl), so the Nth outstanding call is paired against the Nth pong a connection receives. Extracted out of mesh-session.ts the same way relay-pairing.ts already extracts its own relay-pairing bookkeeping, so mesh-session.ts's own applyFrame/sendPingMeasureRtt stay thin wiring rather than owning this queue's mechanics directly.

/** Why a ping was given up on: no pong arrived within the caller's `timeoutMs`. A call rejected for any other reason (the connection dropped or closed first) rejects with a plain Error, so a caller counting unanswered pings tells the two apart by this class rather than by message text. */
export class PingTimeoutError extends Error {
  constructor() {
    super("timed out waiting for pong");
    this.name = "PingTimeoutError";
  }
}

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

  function cancel(registration: Readonly<PendingPingRoundTrip>): boolean {
    const index = pending.indexOf(registration);
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
      let registration: PendingPingRoundTrip | undefined;
      const rtt = new Promise<number>((resolve, reject) => {
        registration = { sentAt, resolve, reject };
        pending.push(registration);
      });
      if (registration === undefined) {
        throw new Error("the round trip was not registered");
      }
      const registered = registration;
      // A close can settle the registration while the ping is still being sent, or after sending it failed, before anything waits on `rtt`. Giving it a handler now keeps that from being an unhandled rejection; the caller still sees the rejection through the promise this returns.
      rtt.catch(() => undefined);
      try {
        await sendPing();
      } catch (error) {
        // The ping never left, so no pong will answer it: leaving it registered would pair the next live ping's pong with this dead entry.
        cancel(registered);
        throw error;
      }
      if (timeoutMs === undefined) {
        return rtt;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;

      return Promise.race([
        rtt,
        new Promise<number>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (cancel(registered)) {
              reject(new PingTimeoutError());
            }
          }, timeoutMs);
        }),
      ]).finally(() => {
        clearTimeout(timer);
      });
    },
  };
}
