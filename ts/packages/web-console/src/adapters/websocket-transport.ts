// A browser Transport implementation over native WebSocket messages, the same convention as the hub's Worker-side adapter: each binary WebSocket message is already self-delimiting, so one message carries exactly one CBOR-encoded frame with no length prefix. Undecodable bytes are a connection-level failure (the receive iteration rejects and the socket closes), matching core's adapters' treatment of hostile wire input; a decodable frame that fails schema validation is dropped rather than disconnecting -- an unrecognised frame from a newer peer is what version negotiation exists to tolerate.

import type { Frame } from "@exadev/wire-mesh-core/generated/protocol";
import type {
  Connection,
  Listener,
  Transport,
} from "@exadev/wire-mesh-core/ports/transport";
import {
  SchemaInvalidFrameError,
  decodeMessage,
  messageFromFrame,
} from "@exadev/wire-mesh-core/adapters/frame-codec";

// RFC 6455 close codes, named rather than bare: 1000 normal closure, 1002 protocol error.
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;

/** A console cannot accept inbound connections, so listen() always rejects -- the port is a client here, exactly like core's other edge adapters are servers where the runtime allows it. */
const LISTEN_UNSUPPORTED = "the web console is a client only: it cannot listen";

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
      // Only binary messages carry frames; a text message is a protocol violation on this connection, same class as undecodable bytes.
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
        next: async (): Promise<IteratorResult<Frame>> => receiveNext(),
      };
    },
  };

  async function receiveNext(): Promise<IteratorResult<Frame>> {
    const next = pending.shift();
    if (next !== undefined) {
      return Promise.resolve({ value: next, done: false });
    }
    if (failure !== null) {
      return Promise.reject(failure);
    }
    if (ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

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

export function createBrowserTransport(): Transport {
  return {
    async connect(address): Promise<Connection> {
      const url = new URL(address);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        return Promise.reject(new Error(`not a WebSocket address: ${address}`));
      }
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      return new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => {
          resolve();
        });
        ws.addEventListener("error", () => {
          reject(new Error(`connect to ${url.toString()} failed`));
        });
      }).then(() => wrapWebSocket(ws));
    },
    async listen(): Promise<Listener> {
      return Promise.reject(new Error(LISTEN_UNSUPPORTED));
    },
  };
}
