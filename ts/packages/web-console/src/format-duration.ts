// Elapsed time as a person reads it ("3 s ago", "4 min ago"), kept pure so the thresholds can be tested.

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** `elapsedMs` as a coarse "N unit ago", or "just now" under a second. A negative value (a peer's clock running ahead of this one) reads as "just now" too, since a peer cannot have been seen in the future. */
export function formatAgo(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / MS_PER_SECOND);
  if (seconds < 1) return "just now";
  if (seconds < SECONDS_PER_MINUTE) return `${String(seconds)} s ago`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${String(hours)} h ago`;
  return `${String(Math.floor(hours / HOURS_PER_DAY))} d ago`;
}

/** `remainingMs` as "N s" rounded up, so a countdown never reads 0 s while time is still left. */
export function formatRemaining(remainingMs: number): string {
  return `${String(Math.max(0, Math.ceil(remainingMs / MS_PER_SECOND)))} s`;
}
