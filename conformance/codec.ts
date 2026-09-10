// Shared JSON<->wire helpers for the conformance vector generator and its vitest suite.
//
// JSON has no byte-string type, so every CDDL `bstr` field is represented in a vector's `message` as `{ "hex": "<lowercase hex>" }` rather than a raw string or array of numbers -- this keeps `message` valid, diffable JSON while still letting the codec reconstruct exactly the bytes CBOR needs. `toWire` walks a `message` value replacing every such marker with a real byte buffer before encoding; `fromWire` walks a decoded value the other way, turning every real byte string back into the same marker shape so it can be compared against the original `message` with a plain deep-equal.

export interface HexBytes {
  hex: string;
}

export type JsonWire =
  | null
  | boolean
  | number
  | string
  | HexBytes
  | JsonWire[]
  | { [key: string]: JsonWire };

export interface Vector {
  name: string;
  message: JsonWire;
  wire_hex: string;
}

export interface VectorFile {
  protocol_version: number;
  description: string;
  vectors: Vector[];
}

export function hex(value: string): HexBytes {
  return { hex: value.toLowerCase() };
}

function isHexBytes(value: unknown): value is HexBytes {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  if (!("hex" in value)) return false;
  if (Object.keys(value).length !== 1) return false;
  return typeof value.hex === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Map)
  );
}

export function toWire(value: JsonWire): unknown {
  if (isHexBytes(value)) {
    // A plain Uint8Array, not a Node Buffer: cbor2's encoder dispatches on the exact constructor and doesn't recognise Buffer as a byte string, falling back to Buffer's own toJSON() and encoding it as a garbled {type, data} map instead -- confirmed directly, not a hypothetical.
    return Uint8Array.from(Buffer.from(value.hex, "hex"));
  }
  if (Array.isArray(value)) {
    return value.map(toWire);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toWire(v);
    return out;
  }
  return value;
}

export function fromWire(value: unknown): JsonWire {
  if (value instanceof Uint8Array) {
    return hex(Buffer.from(value).toString("hex"));
  }
  if (Array.isArray(value)) {
    return value.map(fromWire);
  }
  if (value instanceof Map) {
    const out: Record<string, JsonWire> = {};
    for (const [k, v] of value.entries()) out[String(k)] = fromWire(v);
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, JsonWire> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fromWire(v);
    return out;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  throw new Error(
    `fromWire: unsupported decoded value of type ${typeof value}`,
  );
}

function isJsonWire(value: unknown): value is JsonWire {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonWire);
  if (typeof value === "object") return Object.values(value).every(isJsonWire);
  return false;
}

function isVector(value: unknown): value is Vector {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || !("message" in value) || !("wire_hex" in value))
    return false;
  return (
    typeof value.name === "string" &&
    isJsonWire(value.message) &&
    typeof value.wire_hex === "string"
  );
}

export function isVectorFile(value: unknown): value is VectorFile {
  if (typeof value !== "object" || value === null) return false;
  if (!("vectors" in value)) return false;
  return Array.isArray(value.vectors) && value.vectors.every(isVector);
}
