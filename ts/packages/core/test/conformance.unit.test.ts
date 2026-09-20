// This package's own conformance-check: every vector in conformance/'s golden files decodes to something the generated schemas accept, and re-encoding the validated value reproduces the recorded wire_hex exactly. Mirrors cddl.js's own round-trip test, but here the schemas come from this package's real dependency on cddl.js plus its committed src/generated/protocol.ts, not a local emitModule() call.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  capabilityTokenSchema,
  frameSchema,
  peerAdvertSchema,
} from "../src/generated/protocol.js";
import {
  deriveDeviceId,
  verifyWithPublicKey,
} from "../src/adapters/node-identity.js";
import {
  peerAdvertSigningInput,
  verifyPeerAdvert,
} from "../src/domain/peer-advert.js";

interface Vector {
  name: string;
  wire_hex: string;
}

/** conformance/adverts.v1.json's own richer vector shape: alongside the usual round trip it pins the exact bytes an advert's signature covers, and the verdict a conformant verifier must reach for it. */
interface AdvertVector extends Vector {
  signing_input_hex: string;
  verifies: boolean;
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

function isAdvertVector(value: Readonly<Vector>): value is AdvertVector {
  if (!("signing_input_hex" in value) || !("verifies" in value)) return false;
  return (
    typeof value.signing_input_hex === "string" &&
    typeof value.verifies === "boolean"
  );
}

/** The verification half of the Node identity adapter, which is all an advert needs checking against: an advert is self-certifying, so nothing here holds a key of its own. */
const advertVerifier = { verify: verifyWithPublicKey, deriveDeviceId };

describe("peer-advert vectors agree with this implementation on both the signed bytes and the verdict", () => {
  for (const vector of readVectors("adverts.v1.json")) {
    it(vector.name, async () => {
      roundTrip(vector, peerAdvertSchema);
      expect(
        isAdvertVector(vector),
        `"${vector.name}" is missing signing_input_hex or verifies`,
      ).toBe(true);
      if (!isAdvertVector(vector)) return;

      const bytes = Uint8Array.from(Buffer.from(vector.wire_hex, "hex"));
      const advert = peerAdvertSchema.parse(decode(bytes, cdeDecodeOptions));

      // The frozen signing input is what actually keeps two implementations interoperable: one that reconstructs it even a byte differently rejects every advert the other sends while still passing its own tests.
      expect(
        Buffer.from(peerAdvertSigningInput(advert)).toString("hex"),
        `"${vector.name}" signing input did not match the frozen bytes`,
      ).toBe(vector.signing_input_hex);

      expect(
        await verifyPeerAdvert(advertVerifier, advert),
        `"${vector.name}" verdict did not match the frozen one`,
      ).toBe(vector.verifies);
    });
  }
});
