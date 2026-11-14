// Work started without anyone awaiting it. A promise nobody awaits that rejects is an unhandled rejection, which ends a Node process by default and is reported as an error in a browser, so every such start names what happens to its failure.

import { describeFault } from "wire-mesh-core/domain/fault-report";

/**
 * Starts `work` without waiting for it. Its failure is told to `onFault` when one is given, and is otherwise written to the console as one bounded, quoted line: a failure is never swallowed without a trace, and it never reaches the runtime as an unhandled rejection.
 */
export function startInBackground(
  work: Readonly<Promise<unknown>>,
  onFault: (error: unknown) => void = reportToConsole,
): void {
  work.catch((error: unknown) => {
    onFault(error);
  });
}

function reportToConsole(error: unknown): void {
  console.error(`background work failed: ${describeFault(error)}`);
}
