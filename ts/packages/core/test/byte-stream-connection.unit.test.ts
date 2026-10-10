import { describe, expect, it } from "vitest";
import {
  connectionFromByteStream,
  encodeLengthPrefixedFrame,
  MAX_FRAME_BYTES,
  STREAM_OPEN_MARKER,
  type ByteStream,
} from "../src/adapters/byte-stream-connection.js";
import type { Frame } from "../src/generated/protocol.js";

const PING: Frame = { type: "ping" };
const PONG: Frame = { type: "pong" };

/** Where inside the two-frame message the first chunk ends: mid-way through the first frame's header, so the split falls inside a length prefix. */
const SPLIT_INSIDE_HEADER = 2;
const LENGTH_PREFIX_BYTES = 4;
const NOT_CBOR_BYTE = 0xff;

/** Two ends of one duplex byte stream: what one writes, the other reads. */
function duplexPair(): [ByteStream, ByteStream] {
  const toSecond = new TransformStream<Uint8Array, Uint8Array>();
  const toFirst = new TransformStream<Uint8Array, Uint8Array>();

  return [
    { readable: toFirst.readable, writable: toSecond.writable },
    { readable: toSecond.readable, writable: toFirst.writable },
  ];
}

async function firstFrame(
  frames: Readonly<AsyncIterable<Frame>>,
): Promise<Frame | undefined> {
  for await (const frame of frames) {
    return frame;
  }

  return undefined;
}

describe("connectionFromByteStream", () => {
  it("delivers a frame one side sends to the other, both ways", async () => {
    const [left, right] = duplexPair();
    const a = connectionFromByteStream(left);
    const b = connectionFromByteStream(right);
    const atB = firstFrame(b.receive());
    await a.send(PING);
    expect(await atB).toEqual(PING);
    const atA = firstFrame(a.receive());
    await b.send(PONG);
    expect(await atA).toEqual(PONG);
  });

  it("reassembles a frame split across chunks and separates frames joined in one", async () => {
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const sink = new TransformStream<Uint8Array, Uint8Array>();
    const connection = connectionFromByteStream({
      readable: source.readable,
      writable: sink.writable,
    });
    const first = encodeLengthPrefixedFrame(PING);
    const second = encodeLengthPrefixedFrame(PONG);
    const joined = new Uint8Array([...first, ...second]);
    const writer = source.writable.getWriter();
    const received: Frame[] = [];
    const reading = (async () => {
      for await (const frame of connection.receive()) {
        received.push(frame);
        if (received.length === 2) {
          return;
        }
      }
    })();
    await writer.write(joined.slice(0, SPLIT_INSIDE_HEADER));
    await writer.write(joined.slice(SPLIT_INSIDE_HEADER));
    await reading;
    expect(received).toEqual([PING, PONG]);
  });

  it("skips a stream-open marker and delivers the frame after it", async () => {
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const sink = new TransformStream<Uint8Array, Uint8Array>();
    const connection = connectionFromByteStream({
      readable: source.readable,
      writable: sink.writable,
    });
    const outcome = firstFrame(connection.receive());
    const writer = source.writable.getWriter();
    await writer.write(STREAM_OPEN_MARKER);
    await writer.write(encodeLengthPrefixedFrame(PING));
    expect(await outcome).toEqual(PING);
  });

  it("makes a stream the peer has not yet read visible by writing a marker when opened", async () => {
    const [left, right] = duplexPair();
    const opener = connectionFromByteStream(left, { opened: true });
    const acceptor = connectionFromByteStream(right);
    const atAcceptor = firstFrame(acceptor.receive());
    await opener.send(PING);
    expect(await atAcceptor).toEqual(PING);
  });

  it("ends receive() when the peer closes", async () => {
    const [left, right] = duplexPair();
    const a = connectionFromByteStream(left);
    const b = connectionFromByteStream(right);
    const atB = firstFrame(b.receive());
    await a.close();
    expect(await atB).toBeUndefined();
  });

  it("rejects receive() for a length prefix above the limit", async () => {
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const sink = new TransformStream<Uint8Array, Uint8Array>();
    const connection = connectionFromByteStream({
      readable: source.readable,
      writable: sink.writable,
    });
    const header = new Uint8Array(LENGTH_PREFIX_BYTES);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
    const outcome = expect(firstFrame(connection.receive())).rejects.toThrow(
      "exceeds the",
    );
    await source.writable.getWriter().write(header);
    await outcome;
  });

  it("rejects receive() for a body that is not CBOR", async () => {
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const sink = new TransformStream<Uint8Array, Uint8Array>();
    const connection = connectionFromByteStream({
      readable: source.readable,
      writable: sink.writable,
    });
    const notCbor = new Uint8Array([0, 0, 0, 1, NOT_CBOR_BYTE]);
    const outcome = expect(firstFrame(connection.receive())).rejects.toThrow();
    await source.writable.getWriter().write(notCbor);
    await outcome;
  });
});
