import type { DeviceId } from "../generated/protocol.js";

/** What `onFault` is told besides the error. */
export interface FaultContext {
  /** The peer the failing hello or send was for, when it is known by then. */
  readonly peer: DeviceId | undefined;
  /** How many reports for this peer were withheld since the last one: at most one report per peer is made per handshake window. */
  readonly suppressed: number;
}

/** What the owner of a session hears of failures local to this side: the error, and which peer it was for and how many reports for that peer were withheld. */
export type LocalFaultHandler = (
  error: unknown,
  context: FaultContext,
) => void | Promise<void>;
