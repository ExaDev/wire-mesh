Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const require_generated_protocol = require("../generated/protocol.cjs");
let cbor2 = require("cbor2");
//#region src/adapters/frame-codec.ts
function messageFromFrame(frame) {
	return new Uint8Array((0, cbor2.encode)(frame, cbor2.cdeEncodeOptions));
}
/** A frame that fails schema validation, caught separately from a decode failure so it can be dropped without disconnecting. */
var SchemaInvalidFrameError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "SchemaInvalidFrameError";
	}
};
/** Decodes one message, distinguishing a decode failure (connection-level) from a schema failure (drop this frame, keep the connection). */
function decodeMessage(data) {
	const decoded = (0, cbor2.decode)(new Uint8Array(data), cbor2.cdeDecodeOptions);
	const result = require_generated_protocol.frameSchema.safeParse(decoded);
	if (!result.success) throw new SchemaInvalidFrameError(result.error.message);
	return result.data;
}
/** Best-effort decode of a nested Frame from raw bytes, e.g. a relay-data frame's opaque payload -- unlike decodeMessage, neither a CBOR decode failure nor a schema mismatch is a connection-level failure here: the bytes may simply not be a nested Frame at all (ordinary opaque relay-data with some other meaning), so this returns null instead of throwing either way. */
function tryDecodeFrame(bytes) {
	let decoded;
	try {
		decoded = (0, cbor2.decode)(bytes, cbor2.cdeDecodeOptions);
	} catch {
		return null;
	}
	const result = require_generated_protocol.frameSchema.safeParse(decoded);
	return result.success ? result.data : null;
}
//#endregion
exports.SchemaInvalidFrameError = SchemaInvalidFrameError;
exports.decodeMessage = decodeMessage;
exports.messageFromFrame = messageFromFrame;
exports.tryDecodeFrame = tryDecodeFrame;
