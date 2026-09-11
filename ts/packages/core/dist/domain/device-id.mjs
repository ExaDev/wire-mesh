import { deviceIdSchema } from "../generated/protocol.mjs";
//#region src/domain/device-id.ts
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;
const DEVICE_ID_HEX_LENGTH = 64;
/** Lowercase, byte-exact hex -- the same encoding room.cddl's device-id-hex regex and the conformance vectors' synthetic device-ids already use. */
function deviceIdToHex(device) {
	let hex = "";
	for (const byte of device) hex += byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0");
	return hex;
}
/** Parses a lowercase, 64-character device-id-hex string back into the 32-byte DeviceId it encodes. Throws on anything that isn't exactly that shape, rather than silently truncating or zero-padding a malformed input. */
function deviceIdFromHex(hex) {
	if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`expected a 64-character lowercase hex string, got ${JSON.stringify(hex)}`);
	const bytes = new Uint8Array(DEVICE_ID_HEX_LENGTH / HEX_BYTE_WIDTH);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * HEX_BYTE_WIDTH, (i + 1) * HEX_BYTE_WIDTH), HEX_RADIX);
	return deviceIdSchema.parse(bytes);
}
//#endregion
export { deviceIdFromHex, deviceIdToHex };
