// A Node Transport implementation over the `ws` package (not the platform WebSocket -- Node has no native one), following the exact convention already established by cloudflare-hub's and web-console's own WebSocket adapters: each binary WebSocket message is already self-delimiting, so one message carries exactly one CBOR-encoded frame with no length prefix. Undecodable bytes are a connection-level failure (the receive iteration rejects and the socket closes), matching every other adapter's treatment of hostile wire input; a decodable frame that fails schema validation is dropped rather than disconnecting -- an unrecognised frame from a newer peer is what version negotiation exists to tolerate. Unlike the browser adapter (always rejects listen()) or the cloudflare-hub adapter (no listen() at all, ingress arrives via the Durable Object's own upgrade handling), this adapter's listen() is a real implementation: this package's entire point is being a self-hostable LAN relay.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
import { WebSocket, WebSocketServer, type RawData } from "ws";

// RFC 6455 close codes, named rather than bare: 1000 normal closure, 1002 protocol error.
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const HTTP_NOT_FOUND = 404;

function parseAddress(address: string): { host: string; port: number } {
  const lastColon = address.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(`expected "host:port", got "${address}"`);
  }
  return {
    host: address.slice(0, lastColon),
    port: Number(address.slice(lastColon + 1)),
  };
}

export function messageFromFrame(frame: Frame): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encode(frame, cdeEncodeOptions));
}

/** A frame that fails schema validation, caught separately from a decode failure so it can be dropped without disconnecting the peer. */
class SchemaInvalidFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaInvalidFrameError";
  }
}

/** Decodes one message, distinguishing a decode failure (connection-level) from a schema failure (drop this frame, keep the connection) -- mirroring the other adapters' split between the two. */
function decodeMessage(data: Uint8Array): Frame {
  let decoded: unknown;
  try {
    decoded = decode(data, cdeDecodeOptions);
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

/** Narrows `ws`'s RawData (Buffer | ArrayBuffer | Buffer[]) to a single contiguous Uint8Array. `ws` only ever delivers an array of buffers when a message arrives fragmented across a stream that itself isn't being reassembled -- doesn't happen for the default (non-streamed) receive path this adapter uses. */
function bytesFromRawData(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    throw new Error("expected a single WebSocket message, got fragments");
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  // A Node Buffer is already a Uint8Array subclass; no conversion needed.
  return data;
}

/** Wraps an already-open `ws` WebSocket (client or server side) as a Connection, driven through `ws`'s EventEmitter API (`.on`, not `.addEventListener` -- this repo's other Node-native adapter, tcp-transport.ts, uses the same idiomatic-Node style; `.addEventListener` is reserved for the two adapters wrapping an actual platform WebSocket). */
export function wrapNodeWebSocket(ws: WebSocket): Connection {
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

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      // A text message from a confused or hostile client is a protocol violation on this connection, same class as undecodable bytes.
      failAll(new Error("expected a binary WebSocket message"));
      ws.close(CLOSE_PROTOCOL_ERROR, "protocol error");
      return;
    }
    let frame: Frame;
    try {
      frame = decodeMessage(bytesFromRawData(data));
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
  ws.on("close", endAll);
  ws.on("error", endAll);

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

export interface NodeWebSocketTransportOptions {
  /** Answers a non-Upgrade HTTP request landing on the same listener (e.g. a health check). Requests are 404'd if omitted. */
  onHttpRequest?: (request: IncomingMessage, response: ServerResponse) => void;
}

/** A Node `ws`-based Transport: one CBOR frame per binary WebSocket message, served over a plain `http.Server` this adapter owns. `listen()` is a real implementation (unlike the browser adapter, a client can never accept connections) and supports port 0 for an OS-assigned port, reading the real bound address back the same way core's tcp-transport.ts does. */
export function createNodeWebSocketTransport(
  options: Readonly<NodeWebSocketTransportOptions> = {},
): Transport {
  return {
    async connect(address): Promise<Connection> {
      const { host, port } = parseAddress(address);
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${host}:${String(port)}`);
        ws.once("open", () => {
          resolve(wrapNodeWebSocket(ws));
        });
        ws.once("error", reject);
      });
    },
    async listen(address, onConnection): Promise<Listener> {
      const { host, port } = parseAddress(address);
      return new Promise((resolve, reject) => {
        const httpServer = createServer((request, response) => {
          if (options.onHttpRequest) {
            options.onHttpRequest(request, response);
            return;
          }
          response.writeHead(HTTP_NOT_FOUND).end();
        });
        const wss = new WebSocketServer({ server: httpServer });
        wss.on("connection", (ws) => {
          onConnection(wrapNodeWebSocket(ws));
        });
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          const bound = httpServer.address();
          if (bound === null || typeof bound === "string") {
            // A TCP server's bound address is always an AddressInfo object; null only if the server were not listening, which cannot hold inside this listening callback.
            reject(new Error("listener did not report a bound address"));
            return;
          }
          const listener: Listener = {
            close: async () =>
              new Promise((resolveClose) => {
                wss.close(() => {
                  httpServer.close(() => {
                    resolveClose();
                  });
                });
              }),
            address: `${bound.address}:${String(bound.port)}`,
          };
          resolve(listener);
        });
      });
    },
  };
}
