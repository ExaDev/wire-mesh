// For every vector in every *.v1.json in this directory, confirms both directions independently: decoding wire_hex reproduces message exactly, and re-encoding message reproduces wire_hex exactly. adverts.v1.json's own extra fields (the signing input, and the verdict a verifier must reach) and secure-channel.v1.json's secure_channel section are deliberately not checked here: this package has no protocol implementation of its own to check them against, so they are the implementations' own conformance checks to run, and this suite covers only what every vector file shares.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { encode, decode, cdeEncodeOptions, cdeDecodeOptions } from "cbor2";
import { fromWire, toWire, isVectorFile } from "@exadev/wire-mesh-conformance";

/** The top-level keys every vector file has and this suite reads. */
const SHARED_KEYS = ["protocol_version", "description", "vectors"];

/** Top-level sections a file carries beyond the shared keys, each checked by an implementation's own test (named here), never by this suite. A key a file has that is in neither list fails below, so a new section cannot be added without saying who checks it. */
const SIDECAR_SECTIONS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "secure-channel.v1.json": {
    secure_channel:
      "ts/packages/core/test/conformance-secure-channel.unit.test.ts",
  },
};

// Every vector file in this directory is checked: a file is found by listing the directory, never by a list that a new file could be missing from.
const files = readdirSync(new URL(".", import.meta.url))
  .filter((name) => name.endsWith(".v1.json"))
  .sort();

describe("the vector files", () => {
  it("are found", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("registers only sections whose checking test exists", () => {
    for (const sections of Object.values(SIDECAR_SECTIONS)) {
      for (const test of Object.values(sections)) {
        expect(existsSync(new URL(`../${test}`, import.meta.url)), test).toBe(
          true,
        );
      }
    }
    expect(
      Object.keys(SIDECAR_SECTIONS).filter((name) => !files.includes(name)),
    ).toEqual([]);
  });

  for (const filename of files) {
    it(`${filename} has only keys that something reads`, () => {
      const raw: unknown = JSON.parse(
        readFileSync(new URL(filename, import.meta.url), "utf8"),
      );
      if (typeof raw !== "object" || raw === null) {
        throw new Error(`${filename} is not an object`);
      }
      const known = [
        ...SHARED_KEYS,
        ...Object.keys(SIDECAR_SECTIONS[filename] ?? {}),
      ];
      expect(
        Object.keys(raw).filter((key) => !known.includes(key)),
        `${filename} has a top-level key nothing is registered to check`,
      ).toEqual([]);
    });
  }
});

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
