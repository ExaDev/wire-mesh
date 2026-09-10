import type { Frame } from "../generated/protocol.js";

/**
 * An async, serialisable-data contract for exchanging frame values over some connection -- deliberately without baking in any specific transport's own primitives (no raw socket types, no WebSocket-specific options), so a TCP adapter, a WebSocket adapter, or an in-memory adapter for tests can all satisfy it.
 */
export interface Connection {
  send: (frame: Frame) => Promise<void>;
  /** Frames received on this connection, in arrival order, until the connection closes. */
  receive: () => AsyncIterable<Frame>;
  close: () => Promise<void>;
}

export interface Transport {
  connect: (address: string) => Promise<Connection>;
  /** Starts listening; each accepted connection is handed to onConnection. Returns a function that stops listening and closes the listener. */
  listen: (
    address: string,
    onConnection: (connection: Readonly<Connection>) => void,
  ) => Promise<() => Promise<void>>;
}
