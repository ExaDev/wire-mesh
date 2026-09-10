import { connect as netConnect } from "node:net";
import { describe, expect, it } from "vitest";
import { createTcpTransport } from "../src/adapters/tcp-transport.js";

const LENGTH_PREFIX_BYTES = 4;
// A fixed address rather than port 0: the Transport port's listen takes the caller's address and never reports the bound one, so an OS-assigned port would be undiscoverable through the public surface this test deliberately exercises.
const TEST_LISTEN_ADDRESS = "127.0.0.1:44833";
const TEST_LISTEN_PORT = Number(TEST_LISTEN_ADDRESS.split(":")[1]);

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
    const stopListening = await transport.listen(
      TEST_LISTEN_ADDRESS,
      (connection) => {
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
      },
    );

    // A lone top-level CBOR BREAK byte: decode() throws on it inside the socket data handler -- previously an uncaughtException that killed the process
    await writeRawBody(
      TEST_LISTEN_PORT,
      Uint8Array.from(Buffer.from("ff", "hex")),
    );

    const error = await receivedError;
    expect(error).toBeInstanceOf(Error);

    await stopListening();
  });
});
