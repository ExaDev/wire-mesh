// This package's own conformance-check: every vector in conformance/'s golden files decodes to something the generated schemas accept, and re-encoding the validated value reproduces the recorded wire_hex exactly. Mirrors cddl.js's own round-trip test, but here the schemas come from this package's real dependency on cddl.js plus its committed src/generated/protocol.ts, not a local emitModule() call.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  capabilityTokenSchema,
  frameSchema,
} from "../src/generated/protocol.js";

interface Vector {
  name: string;
  wire_hex: string;
}

interface VectorFile {
  vectors: Vector[];
}

function isVectorFile(value: unknown): value is VectorFile {
  if (typeof value !== "object" || value === null) return false;
  if (!("vectors" in value) || !Array.isArray(value.vectors)) return false;
  return value.vectors.every(
    (v: unknown) =>
      typeof v === "object" &&
      v !== null &&
      "name" in v &&
      "wire_hex" in v &&
      typeof v.name === "string" &&
      typeof v.wire_hex === "string",
  );
}

function readVectors(filename: string): Vector[] {
  const path = fileURLToPath(
    new URL(`../../../../conformance/${filename}`, import.meta.url),
  );
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isVectorFile(raw)) {
    throw new Error(`${filename} is not a valid vector file`);
  }
  return raw.vectors;
}

function roundTrip(
  vector: Readonly<Vector>,
  schema: Readonly<{
    safeParse: (value: unknown) => { success: boolean; data?: unknown };
  }>,
): void {
  // A plain Uint8Array, not a Node Buffer -- cbor2 slices embedded byte strings via the input's own subarray(), which on a Buffer returns another Buffer, a constructor cbor2's own encoder doesn't recognise as a byte string.
  const bytes = Uint8Array.from(Buffer.from(vector.wire_hex, "hex"));
  const decoded: unknown = decode(bytes, cdeDecodeOptions);

  const result = schema.safeParse(decoded);
  expect(result.success, `schema rejected vector "${vector.name}"`).toBe(true);

  const reEncoded = Buffer.from(encode(result.data, cdeEncodeOptions)).toString(
    "hex",
  );
  expect(
    reEncoded,
    `re-encoding "${vector.name}" did not reproduce wire_hex`,
  ).toBe(vector.wire_hex);
}

describe("frame vectors decode and re-encode byte-exactly through frameSchema", () => {
  for (const vector of [
    ...readVectors("frames.v1.json"),
    ...readVectors("handshake.v1.json"),
  ]) {
    it(vector.name, () => {
      roundTrip(vector, frameSchema);
    });
  }
});

describe("token vectors decode and re-encode byte-exactly through capabilityTokenSchema", () => {
  for (const vector of readVectors("tokens.v1.json")) {
    it(vector.name, () => {
      roundTrip(vector, capabilityTokenSchema);
    });
  }
});
