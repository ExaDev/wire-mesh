// Reads {handshake,tokens,frames}.v1.json and, for every vector, confirms both directions independently: decoding wire_hex reproduces message exactly, and re-encoding message reproduces wire_hex exactly. Exits non-zero and prints every failure on any mismatch -- never skips or silently tolerates one, since a silently-wrong vector defeats the entire point of a conformance suite.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { encode, decode, cdeEncodeOptions, cdeDecodeOptions } from "cbor2";
import { fromWire, toWire } from "./codec.mjs";

const files = ["handshake.v1.json", "tokens.v1.json", "frames.v1.json"];

let total = 0;
let failed = 0;

for (const filename of files) {
  const url = new URL(filename, import.meta.url);
  const { vectors } = JSON.parse(readFileSync(url, "utf8"));

  for (const { name, message, wire_hex } of vectors) {
    total += 1;
    try {
      const encoded = Buffer.from(encode(toWire(message), cdeEncodeOptions)).toString("hex");
      assert.strictEqual(encoded, wire_hex, "re-encoding message did not reproduce wire_hex");

      const decoded = fromWire(decode(Buffer.from(wire_hex, "hex"), cdeDecodeOptions));
      assert.deepStrictEqual(decoded, message, "decoding wire_hex did not reproduce message");

      console.log(`  ok  ${filename} :: ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${filename} :: ${name}`);
      console.error(`      ${err.message}`);
    }
  }
}

console.log(`\n${total - failed}/${total} vectors verified`);

if (failed > 0) {
  process.exit(1);
}
