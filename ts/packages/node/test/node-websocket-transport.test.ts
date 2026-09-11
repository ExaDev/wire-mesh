import { describe, expect, it } from "vitest";
import { encode } from "cbor2";
import type { Frame } from "wire-mesh-core/generated/protocol";
import type { WebSocket } from "ws";
import {
  createNodeWebSocketTransport,
  messageFromFrame,
  wrapNodeWebSocket,
} from "../src/adapters/node-websocket-transport.js";
import { FakeNodeWebSocket } from "./fake-node-websocket.js";
import { bytesFromHex } from "./hex.js";

const SHA256_BYTE_LENGTH = 32;
const ping: Frame = { type: "ping" };
const CBOR_MAP_ONE_ENTRY_FIRST_BYTE = 0xa1; // a one-entry CBOR map head -- the ping frame, no length prefix
const CBOR_BREAK_BYTE = 0xff; // the CBOR break byte on its own: undecodable as a complete value
const CLOSE_PROTOCOL_ERROR = 1002;
const HTTP_OK = 200;
const POLL_INTERVAL_MS = 10;

async function collect<T>(iterable: Readonly<AsyncIterable<T>>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

describe("wrapNodeWebSocket", () => {
  it("delivers a valid CBOR frame message and encodes sends as single CBOR messages", async () => {
    const ws = new FakeNodeWebSocket();
    const connection = wrapNodeWebSocket(ws as unknown as WebSocket);

    const received = connection.receive()[Symbol.asyncIterator]();
    const nextFrame = received.next();
    ws.emitMessage(messageFromFrame(ping), true);

    expect((await nextFrame).value).toEqual(ping);

    await connection.send(ping);
    expect(ws.sent.length).toBe(1);
    const sent = ws.sent[0];
    const decoded = sent instanceof Uint8Array ? sent : new Uint8Array(0);
    expect(decoded[0]).toBe(CBOR_MAP_ONE_ENTRY_FIRST_BYTE);
  });

  it("rejects the receive iteration on bytes that do not decode as CBOR, and closes the socket", async () => {
    const ws = new FakeNodeWebSocket();
    const connection = wrapNodeWebSocket(ws as unknown as WebSocket);

    const nextFrame = connection.receive()[Symbol.asyncIterator]().next();
    ws.emitMessage(Uint8Array.from([CBOR_BREAK_BYTE]), true);

    await expect(nextFrame).rejects.toThrow();
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it("rejects the receive iteration on a non-binary WebSocket message", async () => {
    const ws = new FakeNodeWebSocket();
    const connection = wrapNodeWebSocket(ws as unknown as WebSocket);

    const nextFrame = connection.receive()[Symbol.asyncIterator]().next();
    ws.emitMessage(new TextEncoder().encode("hello"), false);

    await expect(nextFrame).rejects.toThrow("expected a binary");
    expect(ws.closed).toBe(true);
  });

  it("drops a decodable but schema-invalid frame without ending the connection", async () => {
    const ws = new FakeNodeWebSocket();
    const connection = wrapNodeWebSocket(ws as unknown as WebSocket);

    const received = connection.receive()[Symbol.asyncIterator]();
    const first = received.next();
    // A well-formed CBOR map with the wrong literal: not any known frame. It is dropped, so the next valid frame still arrives and nothing closes.
    ws.emitMessage(
      new Uint8Array(encode({ type: "not-a-real-frame-kind" })),
      true,
    );
    ws.emitMessage(messageFromFrame(ping), true);

    expect((await first).value).toEqual(ping);
    expect(ws.closed).toBe(false);

    const after = collect(connection.receive());
    ws.close();
    expect(await after).toEqual([]);
  });

  it("rejects sends after the connection has ended", async () => {
    const ws = new FakeNodeWebSocket();
    const connection = wrapNodeWebSocket(ws as unknown as WebSocket);
    ws.close();

    await expect(connection.send(ping)).rejects.toThrow("connection is closed");
  });

  it("ends the iteration cleanly when the socket closes", async () => {
    const ws = new FakeNodeWebSocket();
    const connection = wrapNodeWebSocket(ws as unknown as WebSocket);
    const frames = collect(connection.receive());
    ws.close();
    expect(await frames).toEqual([]);
  });

  it("re-encodes a frame to byte-identical CBOR the adapter itself decodes back", async () => {
    const gossip: Frame = {
      type: "gossip",
      peers: [
        {
          device: bytesFromHex("11".repeat(SHA256_BYTE_LENGTH)),
          addresses: ["203.0.113.5:4433"],
          "snapshot-seconds": 1861833600,
        },
      ],
    };
    const ws = new FakeNodeWebSocket();
    const connection = wrapNodeWebSocket(ws as unknown as WebSocket);
    const received = connection.receive()[Symbol.asyncIterator]();
    const nextFrame = received.next();
    ws.emitMessage(messageFromFrame(gossip), true);
    expect((await nextFrame).value).toEqual(gossip);
  });
});

describe("createNodeWebSocketTransport, a real loopback round trip", () => {
  it("listens on an OS-assigned port and exchanges a frame with a real connect()", async () => {
    const serverTransport = createNodeWebSocketTransport();
    const received: Frame[] = [];
    const listener = await serverTransport.listen(
      "127.0.0.1:0",
      (connection) => {
        void (async () => {
          for await (const frame of connection.receive()) {
            received.push(frame);
          }
        })();
      },
    );
    expect(listener.address).toMatch(/^127\.0\.0\.1:\d+$/);

    const clientTransport = createNodeWebSocketTransport();
    const client = await clientTransport.connect(listener.address);
    await client.send(ping);

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (received.length > 0) {
          resolve();
          return;
        }
        setTimeout(check, POLL_INTERVAL_MS);
      };
      check();
    });

    expect(received).toEqual([ping]);

    await client.close();
    await listener.close();
  });

  it("serves the configured onHttpRequest handler for a plain (non-Upgrade) request", async () => {
    const transport = createNodeWebSocketTransport({
      onHttpRequest: (_request, response) => {
        response.writeHead(HTTP_OK, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      },
    });
    const listener = await transport.listen("127.0.0.1:0", () => undefined);

    const response = await fetch(`http://${listener.address}/`);
    expect(response.status).toBe(HTTP_OK);
    expect(await response.json()).toEqual({ ok: true });

    await listener.close();
  });
});
