// The canonical device-id <-> hex-string codec: every place a device-id needs to be a map key, a log line, a room-path component (room.cddl's owner-hex/DM-hex path shapes), or otherwise compared/displayed as text, converges on this pair rather than each caller re-deriving its own byte-to-hex loop. Lowercase, unpadded-per-byte hex is the canonical text form throughout the spec (see device-id-hex in room.cddl and the conformance vectors), so encode/decode here is the single place that convention is enforced.

import { deviceIdSchema, type DeviceId } from "../generated/protocol.js";

const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;
const DEVICE_ID_HEX_LENGTH = 64; // 32 bytes, hex-encoded

/** Lowercase, byte-exact hex for an arbitrary-length byte string -- the same encoding convention deviceIdToHex uses for the fixed-length device-id case, extracted so any other byte string needing a stable, displayable, map-keyable text form (e.g. a token-id, which tokens.cddl defines as an arbitrary-length bstr rather than a 32-byte device-id) can use the identical convention without going through a device-id-shaped function. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0");
  }
  return hex;
}

/** Lowercase, byte-exact hex -- the same encoding room.cddl's device-id-hex regex and the conformance vectors' synthetic device-ids already use. */
export function deviceIdToHex(device: DeviceId): string {
  return bytesToHex(device);
}

/** The arbitrary-length reverse of bytesToHex -- decodes a lowercase, byte-exact hex string back into the bytes it encodes. Throws on an odd-length string, a non-hex character, or a non-lowercase one, rather than silently truncating or normalising a malformed input, matching deviceIdFromHex's own fail-closed convention for the fixed-length case. */
export function bytesFromHex(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/.test(hex)) {
    throw new Error(
      `expected an even-length, lowercase hex string, got ${JSON.stringify(hex)}`,
    );
  }
  const bytes = new Uint8Array(hex.length / HEX_BYTE_WIDTH);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(
      hex.slice(i * HEX_BYTE_WIDTH, (i + 1) * HEX_BYTE_WIDTH),
      HEX_RADIX,
    );
  }
  return bytes;
}

/** Parses a lowercase, 64-character device-id-hex string back into the 32-byte DeviceId it encodes. Throws on anything that isn't exactly that shape, rather than silently truncating or zero-padding a malformed input. */
export function deviceIdFromHex(hex: string): DeviceId {
  if (hex.length !== DEVICE_ID_HEX_LENGTH) {
    throw new Error(
      `expected a 64-character lowercase hex string, got ${JSON.stringify(hex)}`,
    );
  }
  return deviceIdSchema.parse(bytesFromHex(hex));
}
