import { connect as netConnect, createServer, type Socket } from "node:net";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import { frameSchema, type Frame } from "../generated/protocol.js";
import type { Connection, Transport } from "../ports/transport.js";

const LENGTH_PREFIX_BYTES = 4;

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

function writeFrame(socket: Socket, frame: Frame): void {
  const body = encode(frame, cdeEncodeOptions);
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32BE(body.length, 0);
  socket.write(header);
  socket.write(body);
}

/** Reassembles length-prefixed CBOR frames from a byte stream, validating each against frameSchema before handing it to a consumer. */
function frameReader(socket: Socket): AsyncIterable<Frame> {
  let buffer = Buffer.alloc(0);
  const pending: Frame[] = [];
  const waiters: ((value: IteratorResult<Frame>) => void)[] = [];
  let ended = false;

  function tryDrain(): void {
    while (buffer.length >= LENGTH_PREFIX_BYTES) {
      const bodyLength = buffer.readUInt32BE(0);
      if (buffer.length < LENGTH_PREFIX_BYTES + bodyLength) break;
      const body = buffer.subarray(
        LENGTH_PREFIX_BYTES,
        LENGTH_PREFIX_BYTES + bodyLength,
      );
      buffer = buffer.subarray(LENGTH_PREFIX_BYTES + bodyLength);

      const decoded: unknown = decode(body, cdeDecodeOptions);
      const result = frameSchema.safeParse(decoded);
      if (result.success) {
        const waiter = waiters.shift();
        if (waiter) {
          waiter({ value: result.data, done: false });
        } else {
          pending.push(result.data);
        }
      }
      // A frame that fails schema validation is silently dropped from the stream rather than closing the connection -- an unrecognised frame from a newer peer is exactly what version negotiation exists to tolerate.
    }
  }

  function endAll(): void {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    tryDrain();
  });
  socket.on("end", endAll);
  socket.on("close", endAll);

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Frame>> {
          const next = pending.shift();
          if (next !== undefined) {
            return Promise.resolve({ value: next, done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };
}

function wrapSocket(socket: Socket): Connection {
  const frames = frameReader(socket);
  return {
    // Socket.write is not itself async; the contract stays Promise-returning so other adapters (e.g. one with real backpressure/ack semantics) can be genuinely asynchronous.
    send: async (frame) => {
      writeFrame(socket, frame);
      return Promise.resolve();
    },
    receive: () => frames,
    close: async () =>
      new Promise((resolve) => {
        socket.end(() => {
          resolve();
        });
      }),
  };
}

/** A Node net.Socket-based Transport: length-prefixed, CBOR-encoded frames over plain TCP -- matching Cascade's own transport shape, since interop with Cascade nodes is wire-mesh's stated goal. Framing (not TLS) is this adapter's own concern; a TLS-terminated variant is a separate adapter behind the same Transport contract. */
export function createTcpTransport(): Transport {
  return {
    async connect(address) {
      const { host, port } = parseAddress(address);
      return new Promise((resolve, reject) => {
        const socket = netConnect({ host, port });
        socket.once("connect", () => {
          resolve(wrapSocket(socket));
        });
        socket.once("error", reject);
      });
    },
    async listen(address, onConnection) {
      const { host, port } = parseAddress(address);
      return new Promise((resolve, reject) => {
        const server = createServer((socket) => {
          onConnection(wrapSocket(socket));
        });
        server.once("error", reject);
        server.listen(port, host, () => {
          resolve(
            async () =>
              new Promise((resolveClose) => {
                server.close(() => {
                  resolveClose();
                });
              }),
          );
        });
      });
    },
  };
}
