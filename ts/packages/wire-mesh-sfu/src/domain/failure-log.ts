// The SFU's operator log lines for failures, kept apart from the entry point so they can be exercised without starting a media backend.

import {
  createFaultReporter,
  describeFault,
} from "wire-mesh-core/domain/fault-report";

/** One operator log line for a failure: the text is quoted and bounded (it can carry what a peer sent, so a control character in it cannot start a new line), and `suppressed` says how many failures of the same source were not logged before it. */
export function failureLine(
  label: string,
  error: unknown,
  suppressed: number,
): string {
  const more = suppressed > 0 ? ` (${String(suppressed)} more not logged)` : "";

  return `${label} failed: ${describeFault(error)}${more}\n`;
}

/** Logs a connection that failed to set up or tear down, at most one line per interval for all of them together: a connection's failure is known before its peer is, so there is no peer to count it against. A request's failure needs no such layer, since each participant's own request loop already limits its reports per peer. */
export function createParticipantFailureLog(
  write: (line: string) => void,
): (error: unknown) => void {
  const report = createFaultReporter();

  return (error) => {
    report("participant", (suppressed) => {
      write(failureLine("participant", error, suppressed));
    });
  };
}
