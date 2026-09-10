import type { Clock } from "../ports/clock.js";

/** Wraps the system wall clock -- the only place Date.now() appears in this package. */
export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
  };
}
