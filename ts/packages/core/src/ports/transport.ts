import type { DeviceId, Frame } from "../generated/protocol.js";

/**
 * An async, serialisable-data contract for exchanging frame values over some connection -- deliberately without baking in any specific transport's own primitives (no raw socket types, no WebSocket-specific options), so a TCP adapter, a WebSocket adapter, or an in-memory adapter for tests can all satisfy it.
 */
export interface Connection {
  send: (frame: Frame) => Promise<void>;
  /** Frames received on this connection, in arrival order, until the connection closes. */
  receive: () => AsyncIterable<Frame>;
  close: () => Promise<void>;
  /** The peer's device-id, cryptographically authenticated by the adapter itself (never a value read off the wire) -- absent when the adapter has nothing to authenticate against (createTcpTransport) or the peer presented no credential to check (an accepting createTlsTransport connection whose peer sent no certificate). A caller that later receives an application-level claim of who the peer is (e.g. an `introduce`-style message) MUST treat a mismatch against this field as a spoofing attempt and refuse the claim, exactly the same "reject and destroy" obligation self-certifying claims elsewhere in this spec already carry. */
  readonly peerDeviceId?: DeviceId;
  /** Lets the event loop exit while this connection is still open and functioning -- a caller that wants I/O to keep working without keeping the process alive (matching Node's own `net.Socket.unref()`) calls this once. Adapters with no underlying handle to unref (an in-memory test double, a browser WebSocket) simply omit it. */
  unref?: () => void;
}

export interface Listener {
  /** Stops listening and closes the listener. */
  close: () => Promise<void>;
  /** The address actually bound, as "host:port". A caller may pass port 0 to take an OS-assigned port and needs it handed back to connect to (or advertise) -- tests rely on this to avoid fixed-port collisions. */
  address: string;
  /** Lets the event loop exit while this listener is still bound and accepting connections. See Connection.unref for the same rationale; adapters with nothing to unref omit it. */
  unref?: () => void;
}

export interface Transport {
  connect: (address: string) => Promise<Connection>;
  /** Starts listening; each accepted connection is handed to onConnection. Resolves once bound, with the address actually listening on. */
  listen: (
    address: string,
    onConnection: (connection: Readonly<Connection>) => void,
  ) => Promise<Listener>;
}
