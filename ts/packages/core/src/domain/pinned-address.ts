import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";

const PIN_FRAGMENT = "#sha256=";
const HASH_SEPARATOR = ",";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const HEX_RADIX = 16;

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

/** The bytes in a SHA-256 hash. */
const SHA256_BYTES = 32;

/** The most hashes a node may announce at once. A browser is asked to accept any of them, and a longer list is a node misbehaving rather than one advertising a schedule. */
export const MAX_ANNOUNCED_HASHES = 8;

/**
 * The message a node sends a client, on a stream it opens to that client, to say which certificates it serves now and will serve next: a CBOR map with one key, `sha256`, holding an array of 32-byte hashes in the order they take over. It is authentic because it arrives on the session the client pinned, so no signature is needed.
 */
export function encodeCertificateHashes(
  sha256Hex: readonly string[],
): Uint8Array {
  return encode({ sha256: sha256Hex.map(hexToBytes) }, cdeEncodeOptions);
}

/**
 * Reads a message made by `encodeCertificateHashes`.
 * @throws Error when it is not a map with a `sha256` array of one to MAX_ANNOUNCED_HASHES byte strings of 32 bytes each.
 */
export function decodeCertificateHashes(
  bytes: Readonly<Uint8Array>,
): Uint8Array<ArrayBuffer>[] {
  const decoded: unknown = decode(bytes, cdeDecodeOptions);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("sha256" in decoded) ||
    !Array.isArray(decoded.sha256)
  ) {
    throw new Error("expected a map with a sha256 array");
  }
  const announced: unknown[] = decoded.sha256;
  if (announced.length === 0 || announced.length > MAX_ANNOUNCED_HASHES) {
    throw new Error(
      `expected 1 to ${String(MAX_ANNOUNCED_HASHES)} hashes, got ${String(announced.length)}`,
    );
  }
  const hashes: Uint8Array<ArrayBuffer>[] = [];
  for (const hash of announced) {
    if (!(hash instanceof Uint8Array) || hash.length !== SHA256_BYTES) {
      throw new Error(`each hash must be ${String(SHA256_BYTES)} bytes`);
    }
    hashes.push(new Uint8Array(hash));
  }

  return hashes;
}

/** `hashes` followed by those of `more` that are not already in it, so a client can pin what it was given and what it has learned since. */
export function mergeHashes(
  hashes: readonly Uint8Array<ArrayBuffer>[],
  more: readonly Uint8Array<ArrayBuffer>[],
): Uint8Array<ArrayBuffer>[] {
  const known = new Set(hashes.map(bytesToHex));
  const merged = [...hashes];
  for (const hash of more) {
    if (!known.has(bytesToHex(hash))) {
      known.add(bytesToHex(hash));
      merged.push(hash);
    }
  }

  return merged;
}

function bytesToHex(bytes: Readonly<Uint8Array>): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX_RADIX).padStart(2, "0"),
  ).join("");
}

/** `address` with its pinned hashes replaced by `sha256`. */
export function withPinnedHashes(
  address: string,
  sha256: readonly Uint8Array<ArrayBuffer>[],
): string {
  const { url } = parsePinnedAddress(address);
  const parsed = new URL(url);

  return formatPinnedAddress(parsed.host, sha256.map(bytesToHex));
}
