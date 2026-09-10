import { describe, expect, it } from "vitest";
import { encode } from "cbor2";
import type { Frame } from "@exadev/wire-mesh-core/generated/protocol";
import {
  createBrowserTransport,
  wrapWebSocket,
} from "../src/adapters/websocket-transport.js";
import { messageFromFrame } from "../src/adapters/frame-codec.js";
import { FakeWebSocket } from "./fake-websocket.js";
import { bytesFromHex } from "./hex.js";

const SHA256_BYTE_LENGTH = 32;

const ping: Frame = { type: "ping" };
const CBOR_MAP_ONE_ENTRY_FIRST_BYTE = 0xa1; // a one-entry CBOR map head -- the ping frame, no length prefix
const CBOR_BREAK_BYTE = 0xff; // the CBOR break byte on its own: undecodable as a complete value
const CLOSE_PROTOCOL_ERROR = 1002;

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function collect<T>(iterable: Readonly<AsyncIterable<T>>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

describe("wrapWebSocket", () => {
  it("delivers a valid CBOR frame message and encodes sends as single CBOR messages", async () => {
    const ws = new FakeWebSocket("ws://node");
    const connection = wrapWebSocket(ws as unknown as WebSocket);

    const received = connection.receive()[Symbol.asyncIterator]();
    const nextFrame = received.next();
    ws.emitMessage(arrayBuffer(messageFromFrame(ping)));

    expect((await nextFrame).value).toEqual(ping);

    await connection.send(ping);
    expect(ws.sent.length).toBe(1);
    const decoded = new Uint8Array(ws.sent[0] ?? new ArrayBuffer(0));
    expect(decoded[0]).toBe(CBOR_MAP_ONE_ENTRY_FIRST_BYTE);
  });

  it("rejects the receive iteration on bytes that do not decode as CBOR, and closes the socket", async () => {
    const ws = new FakeWebSocket("ws://node");
    const connection = wrapWebSocket(ws as unknown as WebSocket);

    const nextFrame = connection.receive()[Symbol.asyncIterator]().next();
    ws.emitMessage(arrayBuffer(Uint8Array.from([CBOR_BREAK_BYTE])));

    await expect(nextFrame).rejects.toThrow();
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it("rejects the receive iteration on a text WebSocket message", async () => {
    const ws = new FakeWebSocket("ws://node");
    const connection = wrapWebSocket(ws as unknown as WebSocket);

    const nextFrame = connection.receive()[Symbol.asyncIterator]().next();
    ws.emitText("hello");

    await expect(nextFrame).rejects.toThrow("expected a binary");
    expect(ws.closed).toBe(true);
  });

  it("drops a decodable but schema-invalid frame without ending the connection", async () => {
    const ws = new FakeWebSocket("ws://node");
    const connection = wrapWebSocket(ws as unknown as WebSocket);

    const received = connection.receive()[Symbol.asyncIterator]();
    const first = received.next();
    // A well-formed CBOR map with the wrong literal: not any known frame. It is dropped, so the next valid frame still arrives and nothing closes.
    ws.emitMessage(arrayBuffer(encode({ type: "not-a-real-frame-kind" })));
    ws.emitMessage(arrayBuffer(messageFromFrame(ping)));

    expect((await first).value).toEqual(ping);
    expect(ws.closed).toBe(false);

    const after = collect(connection.receive());
    ws.close();
    expect(await after).toEqual([]);
  });

  it("rejects sends after the connection has ended", async () => {
    const ws = new FakeWebSocket("ws://node");
    const connection = wrapWebSocket(ws as unknown as WebSocket);
    ws.close();

    await expect(connection.send(ping)).rejects.toThrow("connection is closed");
  });

  it("ends the iteration cleanly when the socket closes", async () => {
    const ws = new FakeWebSocket("ws://node");
    const connection = wrapWebSocket(ws as unknown as WebSocket);
    const frames = collect(connection.receive());
    ws.close();
    expect(await frames).toEqual([]);
  });

  it("ends the iteration when the socket errors after delivering pending frames", async () => {
    const ws = new FakeWebSocket("ws://node");
    const connection = wrapWebSocket(ws as unknown as WebSocket);
    const frames = collect(connection.receive());
    ws.emitMessage(arrayBuffer(messageFromFrame(ping)));
    ws.emitError();
    expect(await frames).toEqual([ping]);
  });
});

describe("browser transport over real CBOR bytes", () => {
  it("messageFromFrame produces bytes the adapter itself decodes back", async () => {
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
    const ws = new FakeWebSocket("ws://node");
    const connection = wrapWebSocket(ws as unknown as WebSocket);
    const received = connection.receive()[Symbol.asyncIterator]();
    const nextFrame = received.next();
    ws.emitMessage(arrayBuffer(messageFromFrame(gossip)));
    expect((await nextFrame).value).toEqual(gossip);
  });
});

describe("createBrowserTransport", () => {
  it("rejects a non-WebSocket address without constructing anything", async () => {
    const transport = createBrowserTransport();
    await expect(transport.connect("http://localhost:8787")).rejects.toThrow(
      "not a WebSocket address",
    );
  });

  it("rejects listen outright: the console is a client only", async () => {
    const transport = createBrowserTransport();
    let accepted = 0;
    await expect(
      transport.listen("ws://localhost:8787", () => {
        accepted += 1;
      }),
    ).rejects.toThrow("cannot listen");
    expect(accepted).toBe(0);
  });
});
