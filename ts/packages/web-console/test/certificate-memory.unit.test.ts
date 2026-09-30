import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { createCertificateMemory } from "../src/certificate-memory.js";

const HASH_BYTES = 32;
const FIRST_BYTE = 1;
const SECOND_BYTE = 2;
const hash = (byte: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(HASH_BYTES).fill(byte);

describe("createCertificateMemory", () => {
  it("remembers nothing for a node it has not seen", async () => {
    const memory = createCertificateMemory(createMemoryStorage());
    expect(await memory.recall("192.0.2.5:4433")).toEqual([]);
  });

  it("recalls what it last remembered for a node, in order, and keeps nodes apart", async () => {
    const memory = createCertificateMemory(createMemoryStorage());
    await memory.remember("192.0.2.5:4433", [
      hash(FIRST_BYTE),
      hash(SECOND_BYTE),
    ]);
    await memory.remember("192.0.2.6:4433", [hash(SECOND_BYTE)]);
    expect(await memory.recall("192.0.2.5:4433")).toEqual([
      hash(FIRST_BYTE),
      hash(SECOND_BYTE),
    ]);
    expect(await memory.recall("192.0.2.6:4433")).toEqual([hash(SECOND_BYTE)]);
  });

  it("replaces what it had rather than adding to it", async () => {
    const memory = createCertificateMemory(createMemoryStorage());
    await memory.remember("192.0.2.5:4433", [hash(FIRST_BYTE)]);
    await memory.remember("192.0.2.5:4433", [hash(SECOND_BYTE)]);
    expect(await memory.recall("192.0.2.5:4433")).toEqual([hash(SECOND_BYTE)]);
  });
});
