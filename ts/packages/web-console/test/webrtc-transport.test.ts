import { describe, expect, it } from "vitest";
import { encode } from "cbor2";
import type { Frame } from "wire-mesh-core/generated/protocol";
import { wrapRtcDataChannel } from "../src/adapters/webrtc-transport.js";
import { messageFromFrame } from "wire-mesh-core/adapters/frame-codec";
import { FakeRtcDataChannel } from "./fake-rtc-data-channel.js";
import { bytesFromHex } from "./hex.js";

const SHA256_BYTE_LENGTH = 32;

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
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

/** A single typed value from an async iterable -- narrows IteratorResult's done/value union explicitly so the yielded value is Frame, not the any that IteratorResult's default TReturn otherwise leaks into a bare `.value` access. */
async function nextValue<T>(iterable: Readonly<AsyncIterable<T>>): Promise<T> {
  const result = await iterable[Symbol.asyncIterator]().next();
  if (result.done === true) {
    throw new Error("iterator ended without producing a value");
  }
  return result.value;
}

describe("wrapRtcDataChannel", () => {
  it("delivers a valid CBOR frame message and encodes sends as single CBOR messages", async () => {
    const channel = new FakeRtcDataChannel();
    const connection = wrapRtcDataChannel(channel as unknown as RTCDataChannel);

    const received = connection.receive()[Symbol.asyncIterator]();
    const nextFrame = received.next();
    channel.emitMessage(arrayBuffer(messageFromFrame(ping)));

    expect((await nextFrame).value).toEqual(ping);

    await connection.send(ping);
    expect(channel.sent.length).toBe(1);
    const decoded = new Uint8Array(channel.sent[0] ?? new ArrayBuffer(0));
    expect(decoded[0]).toBe(CBOR_MAP_ONE_ENTRY_FIRST_BYTE);
  });

  it("sends while the channel is open", async () => {
    const channel = new FakeRtcDataChannel();
    channel.readyState = "open";
    const connection = wrapRtcDataChannel(channel as unknown as RTCDataChannel);
    await expect(connection.send(ping)).resolves.toBeUndefined();
    expect(channel.sent.length).toBe(1);
  });

  it("rejects a send while the channel is not open", async () => {
    const channel = new FakeRtcDataChannel();
    channel.readyState = "connecting";
    const connection = wrapRtcDataChannel(channel as unknown as RTCDataChannel);
    await expect(connection.send(ping)).rejects.toThrow("not open");
    expect(channel.sent.length).toBe(0);
  });

  it("rejects the receive iteration on bytes that do not decode as CBOR, and closes the channel", async () => {
    const channel = new FakeRtcDataChannel();
    const connection = wrapRtcDataChannel(channel as unknown as RTCDataChannel);

    const nextFrame = connection.receive()[Symbol.asyncIterator]().next();
    channel.emitMessage(arrayBuffer(Uint8Array.from([CBOR_BREAK_BYTE])));

    await expect(nextFrame).rejects.toThrow();
    expect(channel.readyState).toBe("closed");
  });

  it("rejects the receive iteration on a text data channel message", async () => {
    const channel = new FakeRtcDataChannel();
    const connection = wrapRtcDataChannel(channel as unknown as RTCDataChannel);

    const nextFrame = connection.receive()[Symbol.asyncIterator]().next();
    channel.emitText("hello");

    await expect(nextFrame).rejects.toThrow("expected a binary");
    expect(channel.readyState).toBe("closed");
  });

  it("drops a decodable but schema-invalid frame without ending the connection", async () => {
    const channel = new FakeRtcDataChannel();
    const connection = wrapRtcDataChannel(channel as unknown as RTCDataChannel);

    const received = connection.receive()[Symbol.asyncIterator]();
    const first = received.next();
    // A well-formed CBOR map with the wrong literal: not any known frame. It is dropped, so the next valid frame still arrives and the channel stays open.
    channel.emitMessage(arrayBuffer(encode({ type: "not-a-real-frame-kind" })));
    channel.emitMessage(arrayBuffer(messageFromFrame(ping)));

    expect((await first).value).toEqual(ping);
    expect(channel.readyState).toBe("open");

    const after = collect(connection.receive());
    channel.close();
    expect(await after).toEqual([]);
  });

  it("ends the iteration cleanly when the channel closes", async () => {
    const channel = new FakeRtcDataChannel();
    const connection = wrapRtcDataChannel(channel as unknown as RTCDataChannel);
    const frames = collect(connection.receive());
    channel.emitClose();
    expect(await frames).toEqual([]);
  });

  it("ends the iteration when the channel errors after delivering pending frames", async () => {
    const channel = new FakeRtcDataChannel();
    const connection = wrapRtcDataChannel(channel as unknown as RTCDataChannel);
    const frames = collect(connection.receive());
    channel.emitMessage(arrayBuffer(messageFromFrame(ping)));
    channel.emitError();
    expect(await frames).toEqual([ping]);
  });

  it("calling close() closes the underlying data channel", async () => {
    const channel = new FakeRtcDataChannel();
    const connection = wrapRtcDataChannel(channel as unknown as RTCDataChannel);
    await connection.close();
    expect(channel.readyState).toBe("closed");
  });
});

describe("webrtc transport over real CBOR bytes", () => {
  it("messageFromFrame produces bytes the adapter itself decodes back, byte-identical on re-encode", async () => {
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
    const channel = new FakeRtcDataChannel();
    const connection = wrapRtcDataChannel(channel as unknown as RTCDataChannel);
    const encoded = messageFromFrame(gossip);
    const decodedFrame = nextValue(connection.receive());
    channel.emitMessage(arrayBuffer(encoded));
    const resolvedFrame = await decodedFrame;
    expect(resolvedFrame).toEqual(gossip);
    // Round-trip: re-encoding the frame this adapter decoded produces byte-identical output to the original wire bytes.
    expect(messageFromFrame(resolvedFrame)).toEqual(encoded);
  });
});
