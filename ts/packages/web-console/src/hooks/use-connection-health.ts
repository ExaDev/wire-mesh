// Round-trip health of one connection, measured rather than asked for: a ping is sent as soon as the connection is up and on an interval after, each answered pong becoming a sample and each unanswered one a recorded loss. A node that never answers a ping (an ordinary peer, not a relay hub) is detected from its first unanswered probe and left alone, since probing it on an interval would only add noise to its frame log; the manual probe still works and revives the automatic ones if the node does answer.

import { useCallback, useEffect, useRef, useState } from "react";
import type { MeshSession } from "wire-mesh-core/domain/mesh-session";

/** When probes are sent and when one is given up on. */
export interface ProbeTiming {
  /** How long to wait for a pong before counting the probe lost. Must be below `intervalMs` so two probes are never outstanding at once. */
  pongTimeoutMs: number;
  /** The gap between automatic probes. */
  intervalMs: number;
}

/** A pong timeout generously above a healthy round trip, and an interval frequent enough that a degrading link shows within a minute yet rare enough not to crowd the frame log. */
export const DEFAULT_PROBE_TIMING: ProbeTiming = {
  pongTimeoutMs: 5000,
  intervalMs: 15_000,
};

/** The samples kept, which is also how many points the sparkline draws. */
export const MAX_SAMPLES = 40;

/** A measured round trip in milliseconds, or undefined for a probe that got no pong. */
export type RttSample = number | undefined;

export interface ConnectionHealth {
  samples: readonly RttSample[];
  /** True once a probe got no pong and none ever did, meaning the node is not a pinging peer and automatic probing has stopped. */
  unresponsive: boolean;
  /** Sends one probe now and records it. */
  probe: () => void;
}

export function useConnectionHealth(
  session: Readonly<Pick<MeshSession, "sendPingMeasureRtt">>,
  connected: boolean,
  timing: Readonly<ProbeTiming> = DEFAULT_PROBE_TIMING,
): ConnectionHealth {
  const [samples, setSamples] = useState<readonly RttSample[]>([]);
  const [unresponsive, setUnresponsive] = useState(false);
  // Whether any pong has ever come back, kept beside the state because the probe callback must read the latest value when its promise settles.
  const answered = useRef(false);
  // Whether the connection is still up when a probe settles: a probe that failed because the connection dropped says nothing about the node's answers, so it is not recorded.
  const stillConnected = useRef(connected);
  useEffect(() => {
    stillConnected.current = connected;
  }, [connected]);

  const probe = useCallback((): void => {
    session.sendPingMeasureRtt(timing.pongTimeoutMs).then(
      (rtt) => {
        answered.current = true;
        setUnresponsive(false);
        setSamples((current) => [...current, rtt].slice(-MAX_SAMPLES));
      },
      () => {
        if (!stillConnected.current) {
          return;
        }
        setUnresponsive(!answered.current);
        setSamples((current) => [...current, undefined].slice(-MAX_SAMPLES));
      },
    );
  }, [session, timing.pongTimeoutMs]);

  useEffect(() => {
    if (!connected || unresponsive) {
      return undefined;
    }
    probe();
    const timer = setInterval(probe, timing.intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [connected, unresponsive, probe, timing.intervalMs]);

  return { samples, unresponsive, probe };
}
