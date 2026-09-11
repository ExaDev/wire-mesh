import { w as Frame } from "../protocol-B26-5VX7.cjs";
//#region src/adapters/frame-codec.d.ts
export declare function messageFromFrame(frame: Frame): Uint8Array<ArrayBuffer>;
/** A frame that fails schema validation, caught separately from a decode failure so it can be dropped without disconnecting. */
export declare class SchemaInvalidFrameError extends Error {
  constructor(message: string);
}
/** Decodes one message, distinguishing a decode failure (connection-level) from a schema failure (drop this frame, keep the connection). */
export declare function decodeMessage(data: Readonly<ArrayBuffer>): Frame;
/** Best-effort decode of a nested Frame from raw bytes, e.g. a relay-data frame's opaque payload -- unlike decodeMessage, neither a CBOR decode failure nor a schema mismatch is a connection-level failure here: the bytes may simply not be a nested Frame at all (ordinary opaque relay-data with some other meaning), so this returns null instead of throwing either way. */
export declare function tryDecodeFrame(bytes: Readonly<Uint8Array>): Frame | null;
//#endregion