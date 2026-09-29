const PIN_FRAGMENT = "#sha256=";
const HASH_SEPARATOR = ",";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** A WebTransport address and the SHA-256 hashes of the certificates it may serve. */
export interface PinnedAddress {
  /** `https://host:port/`, the URL to open. */
  readonly url: string;
  /** Each acceptable certificate's SHA-256 hash, as bytes. A browser accepts the server's certificate when it matches any of them, so a node can list the certificates it will serve next and an address stays usable across its renewals. */
  readonly sha256: readonly Uint8Array<ArrayBuffer>[];
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The address a node advertises for WebTransport: `https://host:port#sha256=<hex>[,<hex>...]`, the address and the hashes of the certificates it serves now and will serve next. A client that pins the hashes needs nothing else from the network to trust the node, so they travel with the address in one string, which `wire-candidate.address` already permits.
 */
export function formatPinnedAddress(
  hostPort: string,
  sha256Hex: readonly string[],
): string {
  return `https://${hostPort}${PIN_FRAGMENT}${sha256Hex.join(HASH_SEPARATOR)}`;
}

/**
 * Whether an address carries certificate pins, and so is dialled over WebTransport rather than WebSocket.
 */
export function isPinnedAddress(address: string): boolean {
  return address.startsWith("https://") && address.includes(PIN_FRAGMENT);
}

/**
 * Splits an address of the form `https://host:port#sha256=<hex>[,<hex>...]`.
 * @throws Error when the address is not `https://` or does not carry one or more 64-digit lowercase hex hashes.
 */
export function parsePinnedAddress(address: string): PinnedAddress {
  const url = new URL(address);
  const hashes = url.hash.startsWith(PIN_FRAGMENT)
    ? url.hash.slice(PIN_FRAGMENT.length).split(HASH_SEPARATOR)
    : [];
  if (
    url.protocol !== "https:" ||
    hashes.length === 0 ||
    !hashes.every((hash) => SHA256_HEX_PATTERN.test(hash))
  ) {
    throw new Error(
      `expected "https://host:port${PIN_FRAGMENT}<64 hex digits>[${HASH_SEPARATOR}<64 hex digits>...]", got "${address}"`,
    );
  }
  url.hash = "";
  return { url: url.toString(), sha256: hashes.map(hexToBytes) };
}
