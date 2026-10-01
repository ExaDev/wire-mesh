// Elapsed time as a person reads it ("3 s ago", "4 min ago"), kept pure so the thresholds can be tested.

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** `durationMs` as its coarsest whole unit ("3 s", "4 min", "2 h", "5 d"), or undefined under a second. */
function coarseDuration(durationMs: number): string | undefined {
  const seconds = Math.floor(durationMs / MS_PER_SECOND);
  if (seconds < 1) return undefined;
  if (seconds < SECONDS_PER_MINUTE) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${String(hours)} h`;
  return `${String(Math.floor(hours / HOURS_PER_DAY))} d`;
}

/** `elapsedMs` as a coarse "N unit ago", or "just now" under a second. A negative value (a peer's clock running ahead of this one) reads as "just now" too, since a peer cannot have been seen in the future. */
export function formatAgo(elapsedMs: number): string {
  const duration = coarseDuration(elapsedMs);
  return duration === undefined ? "just now" : `${duration} ago`;
}

/** `remainingMs` as a coarse "in N unit", or "in under a second" below a second. */
export function formatUntil(remainingMs: number): string {
  const duration = coarseDuration(remainingMs);
  return duration === undefined ? "in under a second" : `in ${duration}`;
}

/** `remainingMs` as "N s" rounded up, so a countdown never reads 0 s while time is still left. */
export function formatRemaining(remainingMs: number): string {
  return `${String(Math.max(0, Math.ceil(remainingMs / MS_PER_SECOND)))} s`;
}
