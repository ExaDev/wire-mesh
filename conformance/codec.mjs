// Shared JSON<->wire helpers for the conformance vector generator and verifier.
//
// JSON has no byte-string type, so every CDDL `bstr` field is represented in a vector's `message` as `{ "hex": "<lowercase hex>" }` rather than a raw string or array of numbers -- this keeps `message` valid, diffable JSON while still letting the codec reconstruct exactly the bytes CBOR needs. `toWire` walks a `message` value replacing every such marker with a real byte buffer before encoding; `fromWire` walks a decoded value the other way, turning every real byte string back into the same marker shape so it can be compared against the original `message` with a plain deep-equal.

export function hex(value) {
  return { hex: value.toLowerCase() };
}

export function isHexMarker(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.hex === "string"
  );
}

export function toWire(value) {
  if (isHexMarker(value)) {
    // A plain Uint8Array, not a Node Buffer: cbor2's encoder dispatches on the exact constructor and doesn't recognise Buffer as a byte string, falling back to Buffer's own toJSON() and encoding it as a garbled {type, data} map instead -- confirmed directly, not a hypothetical.
    return Uint8Array.from(Buffer.from(value.hex, "hex"));
  }
  if (Array.isArray(value)) {
    return value.map(toWire);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toWire(v);
    return out;
  }
  return value;
}

export function fromWire(value) {
  if (value instanceof Uint8Array) {
    return hex(Buffer.from(value).toString("hex"));
  }
  if (Array.isArray(value)) {
    return value.map(fromWire);
  }
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value.entries()) out[String(k)] = fromWire(v);
    return out;
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fromWire(v);
    return out;
  }
  return value;
}
