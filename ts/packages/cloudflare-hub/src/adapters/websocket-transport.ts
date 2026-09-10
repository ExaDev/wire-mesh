// A Worker-runtime Transport implementation over WebSocket messages. Unlike the TCP adapter -- a stream, needing a length prefix to delimit frames -- each WebSocket binary message is already self-delimiting, so one message carries exactly one CBOR-encoded frame and no prefix is needed. Undecodable bytes are a connection-level failure (the receive iteration rejects and the socket closes), matching the TCP adapter's treatment of hostile wire input; a decodable frame that fails schema validation is dropped rather than disconnecting -- an unrecognised frame from a newer peer is what version negotiation exists to tolerate.

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  frameSchema,
  type Frame,
} from "@exadev/wire-mesh-core/generated/protocol";
import type {
  Connection,
  Listener,
  Transport,
} from "@exadev/wire-mesh-core/ports/transport";

// RFC 6455 close codes, named rather than bare: 1000 normal closure, 1002 protocol error, 1011 the peer (here, the hub) failed.
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_INTERNAL_ERROR = 1011;

export function messageFromFrame(frame: Frame): Uint8Array<ArrayBuffer> {
  // A fresh whole-buffer copy rather than cbor2's own return value: the WebSocket send signatures require a view over a plain ArrayBuffer, and the copy also matches the fresh-buffer discipline the identity adapters apply to anything crossing a runtime boundary.
  return new Uint8Array(encode(frame, cdeEncodeOptions));
}

/** A frame that fails schema validation, caught separately from a decode failure so it can be dropped without disconnecting the peer. */
class SchemaInvalidFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaInvalidFrameError";
  }
}

/** Decodes one message, distinguishing a decode failure (connection-level) from a schema failure (drop this frame, keep the connection) -- mirroring the TCP adapter's split between the two. */
function decodeMessage(data: Readonly<ArrayBuffer>): Frame {
  let decoded: unknown;
  try {
    decoded = decode(new Uint8Array(data), cdeDecodeOptions);
  } catch (error) {
    const connectionError =
      error instanceof Error
        ? error
        : new Error(`frame body failed to decode: ${String(error)}`);
    throw connectionError;
  }
  const result = frameSchema.safeParse(decoded);
  if (!result.success) {
    throw new SchemaInvalidFrameError(result.error.message);
  }
  return result.data;
}

export function wrapWebSocket(ws: Readonly<WebSocket>): Connection {
  const pending: Frame[] = [];
  const waiters: {
    resolve: (result: IteratorResult<Frame>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let ended = false;
  let failure: Error | null = null;

  function endAll(): void {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  function failAll(error: Error): void {
    failure = error;
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  ws.addEventListener("message", (event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) {
      // Only binary messages carry frames; a text message from a confused or hostile client is a protocol violation on this connection, same class as undecodable bytes
      failAll(new Error("expected a binary WebSocket message"));
      ws.close(CLOSE_PROTOCOL_ERROR, "protocol error");
      return;
    }
    let frame: Frame;
    try {
      frame = decodeMessage(event.data);
    } catch (error) {
      if (error instanceof SchemaInvalidFrameError) {
        return;
      }
      failAll(
        error instanceof Error
          ? error
          : new Error(`frame body failed to decode: ${String(error)}`),
      );
      ws.close(CLOSE_PROTOCOL_ERROR, "protocol error");
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve({ value: frame, done: false });
    } else {
      pending.push(frame);
    }
  });
  ws.addEventListener("close", endAll);
  ws.addEventListener("error", endAll);

  const receiveStream: AsyncIterable<Frame> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Frame>> {
          const next = pending.shift();
          if (next !== undefined) {
            return { value: next, done: false };
          }
          if (failure !== null) {
            throw failure;
          }
          if (ended) {
            return { value: undefined, done: true };
          }
          return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
      };
    },
  };

  return {
    // Non-async by promise-returning: the port demands Promise, and the WebSocket API is synchronous underneath -- an async function with no await in its body would only add a microtask hop (same reasoning as core's memory-storage adapter).
    async send(frame): Promise<void> {
      if (ended) {
        return Promise.reject(new Error("connection is closed"));
      }
      ws.send(messageFromFrame(frame));
      return Promise.resolve();
    },
    receive: () => receiveStream,
    async close(): Promise<void> {
      ws.close(CLOSE_NORMAL);
      return Promise.resolve();
    },
  };
}

/** The runtime's WebSocketPair instance type: @cloudflare/workers-types declares WebSocketPair as a value (a constructor) with no separately named type, so the instance side is named via InstanceType. */
export type WebSocketPairInstance = InstanceType<typeof WebSocketPair>;

export interface WebSocketTransport {
  /** The port contract. listen() does not bind anything -- a Worker has no socket listener; inbound connections arrive through the runtime's fetch handler and are fed in via acceptPair below. connect() genuinely dials out over wss:// using the standard WebSocket API, which the Worker runtime provides. */
  transport: Transport;
  /** Called by the Worker entry on each WebSocket upgrade: hands the server side of the pair to whatever onConnection was registered through transport.listen. */
  acceptPair: (pair: WebSocketPairInstance) => void;
}

export function createWebSocketTransport(): WebSocketTransport {
  let onConnection: ((connection: Readonly<Connection>) => void) | null = null;
  const accepted = new Set<Readonly<Connection>>();

  return {
    transport: {
      async connect(address): Promise<Connection> {
        const url = `wss://${address}/mesh`;
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => {
            resolve();
          });
          ws.addEventListener("error", () => {
            reject(new Error(`connect to ${url} failed`));
          });
        });
        const connection = wrapWebSocket(ws);
        accepted.add(connection);
        return connection;
      },
      async listen(address, handler): Promise<Listener> {
        onConnection = handler;
        // A Worker has no bind address to report -- the deployment's own URL is the address peers dial, so the requested address string is echoed back as the listener's label and callers treat it as informational only.
        const bound: Listener = {
          close: async (): Promise<void> => {
            onConnection = null;
            return Promise.all(
              [...accepted].map(async (connection) => connection.close()),
            )
              .then(() => {
                accepted.clear();
              })
              .then(() => undefined);
          },
          address,
        };
        return Promise.resolve(bound);
      },
    },
    acceptPair(pair) {
      if (onConnection === null) {
        pair[1].close(CLOSE_INTERNAL_ERROR, "hub is not accepting connections");
        return;
      }
      pair[1].accept();
      const connection = wrapWebSocket(pair[1]);
      accepted.add(connection);
      onConnection(connection);
    },
  };
}
