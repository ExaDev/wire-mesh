import { connect as netConnect } from "node:net";
import { describe, expect, it } from "vitest";
import { createTcpTransport } from "../src/adapters/tcp-transport.js";

const LENGTH_PREFIX_BYTES = 4;

/** Connects a raw socket (deliberately NOT the transport's own Connection -- the point is to write hostile bytes a well-behaved peer would never produce) and writes one length-prefixed body. */
async function writeRawBody(port: number, body: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
      header.writeUInt32BE(body.length, 0);
      socket.write(header);
      socket.write(body, () => {
        socket.end();
        resolve();
      });
    });
    socket.once("error", reject);
  });
}

describe("createTcpTransport", () => {
  it("surfaces an undecodable frame as a connection-level error, not a process crash", async () => {
    const transport = createTcpTransport();
    let resolveError: (value: unknown) => void;
    const receivedError = new Promise<unknown>((resolve) => {
      resolveError = resolve;
    });
    // Port 0: the OS assigns a free port and the listener reports it back, so concurrent CI runs can never collide on a fixed one
    const listener = await transport.listen("127.0.0.1:0", (connection) => {
      void (async () => {
        const frames: unknown[] = [];
        for await (const frame of connection.receive()) {
          frames.push(frame);
        }
        return frames;
      })().then(
        () => {
          // A non-Error marker: the assertion below distinguishes a genuine rejection from clean completion
          resolveError("COMPLETED");
        },
        (error: unknown) => {
          resolveError(error);
        },
      );
    });

    // A lone top-level CBOR BREAK byte: decode() throws on it inside the socket data handler -- previously an uncaughtException that killed the process
    const assignedPort = Number(listener.address.split(":")[1]);
    await writeRawBody(assignedPort, Uint8Array.from(Buffer.from("ff", "hex")));

    const error = await receivedError;
    expect(error).toBeInstanceOf(Error);

    await listener.close();
  });
});
