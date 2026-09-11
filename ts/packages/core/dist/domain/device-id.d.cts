import { v as DeviceId } from "../protocol-DKGCdPBm.cjs";
//#region src/domain/device-id.d.ts
/** Lowercase, byte-exact hex -- the same encoding room.cddl's device-id-hex regex and the conformance vectors' synthetic device-ids already use. */
export declare function deviceIdToHex(device: DeviceId): string;
/** Parses a lowercase, 64-character device-id-hex string back into the 32-byte DeviceId it encodes. Throws on anything that isn't exactly that shape, rather than silently truncating or zero-padding a malformed input. */
export declare function deviceIdFromHex(hex: string): DeviceId;
//#endregion