// Work started without anyone awaiting it. A promise nobody awaits that rejects is an unhandled rejection, which ends a Node process by default and is reported as an error in a browser, so every such start names what happens to its failure.

/**
 * Starts `work` without waiting for it. Its failure is told to `onFault` when one is given and is otherwise dropped on purpose: the caller chose that nothing needs doing about it. It never reaches the runtime as an unhandled rejection.
 */
export function startInBackground(
  work: Readonly<Promise<unknown>>,
  onFault?: (error: unknown) => void,
): void {
  work.catch((error: unknown) => {
    onFault?.(error);
  });
}
