// For every vector in {handshake,tokens,frames}.v1.json, confirms both directions independently: decoding wire_hex reproduces message exactly, and re-encoding message reproduces wire_hex exactly.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { encode, decode, cdeEncodeOptions, cdeDecodeOptions } from "cbor2";
import { fromWire, toWire, isVectorFile } from "@exadev/wire-mesh-conformance";

const files = ["handshake.v1.json", "tokens.v1.json", "frames.v1.json"];

for (const filename of files) {
  const raw: unknown = JSON.parse(readFileSync(new URL(filename, import.meta.url), "utf8"));
  if (!isVectorFile(raw)) {
    throw new Error(`${filename} is not a valid vector file`);
  }

  describe(filename, () => {
    for (const { name, message, wire_hex } of raw.vectors) {
      it(name, () => {
        const encoded = Buffer.from(encode(toWire(message), cdeEncodeOptions)).toString("hex");
        expect(encoded, "re-encoding message did not reproduce wire_hex").toBe(wire_hex);

        const decoded = fromWire(decode(Buffer.from(wire_hex, "hex"), cdeDecodeOptions));
        expect(decoded, "decoding wire_hex did not reproduce message").toEqual(message);
      });
    }
  });
}
