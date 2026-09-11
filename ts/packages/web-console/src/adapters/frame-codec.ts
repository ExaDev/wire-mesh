// The CBOR frame codec shared by every message-based Connection adapter in this package (WebSocket, WebRTC DataChannel): one CBOR frame per message, no length prefix, with schema validation distinguishing an undecodable payload (connection-level failure) from a decodable-but-unrecognised frame (dropped, connection survives).

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  frameSchema,
  type Frame,
} from "@exadev/wire-mesh-core/generated/protocol";

export function messageFromFrame(frame: Frame): Uint8Array<ArrayBuffer> {
  // A fresh whole-buffer view over a plain ArrayBuffer: the WebSocket/DataChannel send signatures require it, and it matches the fresh-buffer discipline the other adapters apply to anything crossing a runtime boundary.
  return new Uint8Array(encode(frame, cdeEncodeOptions));
}

/** A frame that fails schema validation, caught separately from a decode failure so it can be dropped without disconnecting. */
export class SchemaInvalidFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaInvalidFrameError";
  }
}

/** Decodes one message, distinguishing a decode failure (connection-level) from a schema failure (drop this frame, keep the connection). */
export function decodeMessage(data: Readonly<ArrayBuffer>): Frame {
  const decoded: unknown = decode(new Uint8Array(data), cdeDecodeOptions);
  const result = frameSchema.safeParse(decoded);
  if (!result.success) {
    throw new SchemaInvalidFrameError(result.error.message);
  }
  return result.data;
}

/** Best-effort decode of a nested Frame from raw bytes, e.g. a relay-data frame's opaque payload -- unlike decodeMessage, neither a CBOR decode failure nor a schema mismatch is a connection-level failure here: the bytes may simply not be a nested Frame at all (ordinary opaque relay-data with some other meaning), so this returns null instead of throwing either way. */
export function tryDecodeFrame(bytes: Readonly<Uint8Array>): Frame | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes, cdeDecodeOptions);
  } catch {
    return null;
  }
  const result = frameSchema.safeParse(decoded);
  return result.success ? result.data : null;
}
