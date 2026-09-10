import { describe, expect, it } from "vitest";
import { encode } from "cbor2";
import type { Frame } from "@exadev/wire-mesh-core/generated/protocol";
import {
  messageFromFrame,
  wrapWebSocket,
} from "../src/adapters/websocket-transport.js";

/** A minimal stand-in for the platform's WebSocket, firing events and recording sends -- it stands in for the runtime (the side of the port this adapter does NOT own), exactly what a unit test of an adapter should fake. */
class FakeWebSocket {
  binaryType = "arraybuffer";
  sent: ArrayBuffer[] = [];
  private readonly listeners = new Map<
    string,
    ((event: { data?: unknown }) => void)[]
  >();
  closed = false;

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  private dispatch(type: string, event?: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event ?? {});
    }
  }

  send(data: Readonly<ArrayBuffer>): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.dispatch("close");
  }

  // Test-side drivers
  emitMessage(data: Readonly<ArrayBuffer>): void {
    this.dispatch("message", { data });
  }

  emitError(): void {
    this.dispatch("error");
  }

  accept(): void {
    // Present on the Workers server-side socket; a no-op in the fake.
  }
}

const ping: Frame = { type: "ping" };
const CBOR_MAP_ONE_ENTRY_FIRST_BYTE = 0xa1; // a one-entry CBOR map head -- the ping frame, no length prefix
const CBOR_BREAK_BYTE = 0xff; // the CBOR break byte on its own: undecodable as a complete value

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
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

  it("drops a decodable but schema-invalid frame without ending the connection", async () => {
    const ws = new FakeWebSocket();
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
});
