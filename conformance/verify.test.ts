// For every vector in {handshake,tokens,adverts,frames}.v1.json, confirms both directions independently: decoding wire_hex reproduces message exactly, and re-encoding message reproduces wire_hex exactly. adverts.v1.json's own extra fields (the signing input, and the verdict a verifier must reach) are deliberately not checked here: this package has no protocol implementation of its own to check them against, so they are the implementations' own conformance checks to run, and this suite covers only what every vector file shares.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { encode, decode, cdeEncodeOptions, cdeDecodeOptions } from "cbor2";
import { fromWire, toWire, isVectorFile } from "@exadev/wire-mesh-conformance";

const files = [
  "handshake.v1.json",
  "tokens.v1.json",
  "adverts.v1.json",
  "frames.v1.json",
];

for (const filename of files) {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(filename, import.meta.url), "utf8"),
  );
  if (!isVectorFile(raw)) {
    throw new Error(`${filename} is not a valid vector file`);
  }

  describe(filename, () => {
    for (const { name, message, wire_hex } of raw.vectors) {
      it(name, () => {
        const encoded = Buffer.from(
          encode(toWire(message), cdeEncodeOptions),
        ).toString("hex");
        expect(encoded, "re-encoding message did not reproduce wire_hex").toBe(
          wire_hex,
        );

        const decoded = fromWire(
          decode(Buffer.from(wire_hex, "hex"), cdeDecodeOptions),
        );
        expect(decoded, "decoding wire_hex did not reproduce message").toEqual(
          message,
        );
      });
    }
  });
}
