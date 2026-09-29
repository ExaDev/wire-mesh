const PIN_FRAGMENT = "#sha256=";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** A WebTransport address and the SHA-256 hash of the certificate it is expected to serve. */
export interface PinnedAddress {
  /** `https://host:port/`, the URL to open. */
  readonly url: string;
  /** The certificate's SHA-256 hash, as bytes. */
  readonly sha256: Uint8Array<ArrayBuffer>;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The address a node advertises for WebTransport: `https://host:port#sha256=<hex>`, the address and the hash of the certificate it serves. A client that pins the hash needs nothing else from the network to trust the node, so the pair travels together in one string, which `wire-candidate.address` already permits.
 */
export function formatPinnedAddress(
  hostPort: string,
  sha256Hex: string,
): string {
  return `https://${hostPort}${PIN_FRAGMENT}${sha256Hex}`;
}

/**
 * Whether an address carries a certificate pin, and so is dialled over WebTransport rather than WebSocket.
 */
export function isPinnedAddress(address: string): boolean {
  return address.startsWith("https://") && address.includes(PIN_FRAGMENT);
}

/**
 * Splits an address of the form `https://host:port#sha256=<hex>`.
 * @throws Error when the address is not `https://` or carries no valid 64-digit lowercase hex hash.
 */
export function parsePinnedAddress(address: string): PinnedAddress {
  const url = new URL(address);
  const hex = url.hash.startsWith(PIN_FRAGMENT)
    ? url.hash.slice(PIN_FRAGMENT.length)
    : "";
  if (url.protocol !== "https:" || !SHA256_HEX_PATTERN.test(hex)) {
    throw new Error(
      `expected "https://host:port${PIN_FRAGMENT}<64 hex digits>", got "${address}"`,
    );
  }
  url.hash = "";
  return { url: url.toString(), sha256: hexToBytes(hex) };
}
