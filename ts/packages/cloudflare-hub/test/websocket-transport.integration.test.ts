import { describe, expect, it } from "vitest";
import { decode, encode } from "cbor2";
import type { Frame } from "wire-mesh-core/generated/protocol";
import {
  messageFromFrame,
  wrapWebSocket,
} from "../src/adapters/websocket-transport.js";
import { FakeWebSocket } from "./fake-web-socket.js";
import { bytesFromHex } from "./hex.js";

const ping: Frame = { type: "ping" };
const CBOR_MAP_ONE_ENTRY_FIRST_BYTE = 0xa1; // a one-entry CBOR map head -- the ping frame, no length prefix
const CBOR_BREAK_BYTE = 0xff; // the CBOR break byte on its own: undecodable as a complete value
const samplePayload = bytesFromHex("010203");

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function frameFromBuffer(buffer: Readonly<ArrayBuffer>): unknown {
  return decode(new Uint8Array(buffer));
}

async function collect<T>(iterable: Readonly<AsyncIterable<T>>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("wrapWebSocket", () => {
  it("delivers a valid CBOR frame message and encodes sends as single CBOR messages", async () => {
    const ws = new FakeWebSocket();
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
    const ws = new FakeWebSocket();
    const connection = wrapWebSocket(ws as unknown as WebSocket);

    const nextFrame = connection.receive()[Symbol.asyncIterator]().next();
    ws.emitMessage(arrayBuffer(Uint8Array.from([CBOR_BREAK_BYTE])));

    await expect(nextFrame).rejects.toThrow();
    expect(ws.closed).toBe(true);
  });

  it("treats a text (non-binary) message as a connection-level failure: rejects and closes", async () => {
    const ws = new FakeWebSocket();
    const connection = wrapWebSocket(ws as unknown as WebSocket);

    const nextFrame = connection.receive()[Symbol.asyncIterator]().next();
    ws.emitText("hello");

    await expect(nextFrame).rejects.toThrow(
      "expected a binary WebSocket message",
    );
    expect(ws.closed).toBe(true);
  });

  it("rejects send() after the socket has closed", async () => {
    const ws = new FakeWebSocket();
    const connection = wrapWebSocket(ws as unknown as WebSocket);
    ws.close();

    await expect(connection.send(ping)).rejects.toThrow("connection is closed");
  });

  it("drops a decodable but schema-invalid frame without ending the connection", async () => {
    const ws = new FakeWebSocket();
    const connection = wrapWebSocket(ws as unknown as WebSocket);

    const received = connection.receive()[Symbol.asyncIterator]();
    const first = received.next();
    // A well-formed CBOR map with the wrong literal: not any known frame. It is dropped, so the next valid frame still arrives and nothing closes.
    ws.emitMessage(
      arrayBuffer(new Uint8Array(encode({ type: "not-a-real-frame-kind" }))),
    );
    ws.emitMessage(arrayBuffer(messageFromFrame(ping)));

    expect((await first).value).toEqual(ping);
    expect(ws.closed).toBe(false);

    const after = collect(connection.receive());
    ws.close();
    expect(await after).toEqual([]);
  });

  it("ends the iteration cleanly when the socket closes", async () => {
    const ws = new FakeWebSocket();
    const connection = wrapWebSocket(ws as unknown as WebSocket);
    const frames = collect(connection.receive());
    ws.close();
    expect(await frames).toEqual([]);
  });

  it("ends the iteration when the socket errors after delivering pending frames", async () => {
    const ws = new FakeWebSocket();
    const connection = wrapWebSocket(ws as unknown as WebSocket);
    const frames = collect(connection.receive());
    ws.emitMessage(arrayBuffer(messageFromFrame(ping)));
    ws.emitError();
    expect(await frames).toEqual([ping]);
  });

  it("re-encodes a received frame byte-identically (the round-trip the hub relies on for forwarding)", async () => {
    const ws = new FakeWebSocket();
    const connection = wrapWebSocket(ws as unknown as WebSocket);

    const received = connection.receive()[Symbol.asyncIterator]();
    const nextFrame = received.next();
    const bytes = messageFromFrame({
      type: "relay-data",
      payload: samplePayload,
    });
    ws.emitMessage(arrayBuffer(bytes));

    const result = await nextFrame;
    if (result.done === true) {
      throw new Error("expected a relay-data frame, got stream end");
    }
    expect(result.value).toEqual({
      type: "relay-data",
      payload: samplePayload,
    });
    await connection.send(result.value);
    const forwarded = ws.sent[0];
    expect(new Uint8Array(forwarded ?? new ArrayBuffer(0))).toEqual(bytes);
    expect(frameFromBuffer(forwarded ?? new ArrayBuffer(0))).toEqual(
      frameFromBuffer(arrayBuffer(bytes)),
    );
  });
});
