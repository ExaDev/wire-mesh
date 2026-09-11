import { w as Frame } from "../protocol-DKGCdPBm.cjs";
//#region src/ports/transport.d.ts
/**
 * An async, serialisable-data contract for exchanging frame values over some connection -- deliberately without baking in any specific transport's own primitives (no raw socket types, no WebSocket-specific options), so a TCP adapter, a WebSocket adapter, or an in-memory adapter for tests can all satisfy it.
 */
export interface Connection {
  send: (frame: Frame) => Promise<void>;
  /** Frames received on this connection, in arrival order, until the connection closes. */
  receive: () => AsyncIterable<Frame>;
  close: () => Promise<void>;
}
export interface Listener {
  /** Stops listening and closes the listener. */
  close: () => Promise<void>;
  /** The address actually bound, as "host:port". A caller may pass port 0 to take an OS-assigned port and needs it handed back to connect to (or advertise) -- tests rely on this to avoid fixed-port collisions. */
  address: string;
}
export interface Transport {
  connect: (address: string) => Promise<Connection>;
  /** Starts listening; each accepted connection is handed to onConnection. Resolves once bound, with the address actually listening on. */
  listen: (address: string, onConnection: (connection: Readonly<Connection>) => void) => Promise<Listener>;
}
//#endregion