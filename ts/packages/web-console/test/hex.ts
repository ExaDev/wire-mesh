// Test-side byte construction from hex strings, avoiding the Buffer global (which resolves as any under mixed browser/node type environments).
const HEX_PAIR_LENGTH = 2;
const HEX_RADIX = 16;
const SHA256_BYTE_LENGTH = 32;

export function bytesFromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / HEX_PAIR_LENGTH);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(
      hex.slice(i * HEX_PAIR_LENGTH, (i + 1) * HEX_PAIR_LENGTH),
      HEX_RADIX,
    );
  }
  return out;
}

/** A full synthetic device-id from a one-byte hex fill, the conformance suite's repeated-byte convention. */
export function deviceIdFromFillHex(fillHex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(SHA256_BYTE_LENGTH);
  out.fill(Number.parseInt(fillHex, HEX_RADIX));
  return out;
}
