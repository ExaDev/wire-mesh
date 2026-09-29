import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import { frameSchema, type Frame } from "../generated/protocol.js";
import type { Connection } from "../ports/transport.js";

const LENGTH_PREFIX_BYTES = 4;
const BYTES_PER_KIBIBYTE = 1024;
const BYTES_PER_MEBIBYTE = BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;
const MEBIBYTES_IN_LIMIT = 100;

/** The largest frame body a peer may announce in a length prefix, matching the 100 MiB the `ws` package applies to one message on the same hub, so a WebSocket peer and a byte-stream peer are bounded alike. Without a bound a peer-controlled 4 GiB prefix makes the reader buffer until memory runs out. */
export const MAX_FRAME_BYTES = MEBIBYTES_IN_LIMIT * BYTES_PER_MEBIBYTE;

/** A frame with an empty body, which carries nothing and is skipped by the reader. A QUIC stream is invisible to the peer until a byte crosses it, so the side that opens a stream writes one of these to make it visible before it has a real frame to send. */
export const STREAM_OPEN_MARKER: Uint8Array = new Uint8Array(
  LENGTH_PREFIX_BYTES,
);

/** The two halves of an ordered, reliable byte stream, as the Web Streams API models them: a WebTransport bidirectional stream is one, and so is any other stream a runtime exposes in that shape. */
export interface ByteStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

/** The bytes that carry one frame on a byte stream: a 4-byte big-endian length, then the frame's CBOR body, the same framing the TCP adapter uses. */
export function encodeLengthPrefixedFrame(frame: Frame): Uint8Array {
  const body = encode(frame, cdeEncodeOptions);
  const message = new Uint8Array(LENGTH_PREFIX_BYTES + body.length);
  new DataView(message.buffer).setUint32(0, body.length);
  message.set(body, LENGTH_PREFIX_BYTES);
  return message;
}

function concat(
  first: Readonly<Uint8Array>,
  second: Readonly<Uint8Array>,
): Uint8Array {
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  return joined;
}

/**
 * Frames arriving on a byte stream, in order, until it ends. An empty body (STREAM_OPEN_MARKER) is skipped. A body that does not decode as CBOR, or a length prefix above MAX_FRAME_BYTES, rejects the iteration (a connection-level failure); a body that decodes but fails frame validation is dropped and the stream continues, since an unrecognised frame from a newer peer is what version negotiation exists to tolerate.
 */
async function* readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Frame> {
  let buffered: Uint8Array = new Uint8Array(0);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      buffered = concat(buffered, chunk.value);
      while (buffered.length >= LENGTH_PREFIX_BYTES) {
        const bodyLength = new DataView(
          buffered.buffer,
          buffered.byteOffset,
        ).getUint32(0);
        if (bodyLength > MAX_FRAME_BYTES) {
          throw new Error(
            `frame of ${String(bodyLength)} bytes exceeds the ${String(MAX_FRAME_BYTES)}-byte limit`,
          );
        }
        if (buffered.length < LENGTH_PREFIX_BYTES + bodyLength) {
          break;
        }
        if (bodyLength === 0) {
          buffered = buffered.slice(LENGTH_PREFIX_BYTES);
          continue;
        }
        const body = buffered.slice(
          LENGTH_PREFIX_BYTES,
          LENGTH_PREFIX_BYTES + bodyLength,
        );
        buffered = buffered.slice(LENGTH_PREFIX_BYTES + bodyLength);
        const result = frameSchema.safeParse(decode(body, cdeDecodeOptions));
        if (result.success) {
          yield result.data;
        }
      }
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  }
}

/**
 * A Connection over an ordered, reliable byte stream, one frame per length-prefixed CBOR body. Pass `opened: true` on the side that opened the stream: it writes a STREAM_OPEN_MARKER first, so the peer sees the stream before the first real frame. Pass `opened: true` on the side that opened the stream, which writes a STREAM_OPEN_MARKER first so the peer sees the stream before the first real frame. `close` ends the writable side and cancels the readable side, so the peer sees the stream finish and this side's `receive()` ends.
 */
export function connectionFromByteStream(
  stream: Readonly<ByteStream>,
  options: Readonly<{ opened: boolean }> = { opened: false },
): Connection {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const frames = readFrames(reader);
  const marked = options.opened
    ? writer.write(STREAM_OPEN_MARKER)
    : Promise.resolve();
  // A failure to write the marker resurfaces on the first send, which awaits it.
  marked.catch(() => undefined);
  return {
    send: async (frame) => {
      await marked;
      await writer.write(encodeLengthPrefixedFrame(frame));
    },
    receive: () => frames,
    close: async () => {
      await writer.close();
      await reader.cancel();
    },
  };
}
