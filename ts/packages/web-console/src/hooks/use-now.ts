// The current time from the injected clock, refreshed on an interval while `active`, for views that show elapsed time or a countdown.

import { useEffect, useState } from "react";
import type { Clock } from "wire-mesh-core/ports/clock";

export function useNow(
  clock: Readonly<Clock>,
  active: boolean,
  intervalMs: number,
): number {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => {
      setNow(clock.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [clock, active, intervalMs]);
  return now;
}
