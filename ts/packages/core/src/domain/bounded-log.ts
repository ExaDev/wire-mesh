/** A log that keeps only its most recent `window` entries: newest at the end, the oldest dropped once the window is full. Pure and closure-free, split out of mesh-session.ts to keep that file under this repo's max-lines lint budget; nothing here is session-shaped. */
export function createBoundedLog<T>(window: number): {
  record: (entry: T) => void;
  entries: () => T[];
} {
  const log: T[] = [];

  return {
    record: (entry) => {
      log.push(entry);
      if (log.length > window) {
        log.splice(0, log.length - window);
      }
    },
    entries: () => [...log],
  };
}
