import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { formatPinnedAddress } from "wire-mesh-core/domain/pinned-address";
import { createCertificateMemory } from "../src/certificate-memory.js";
import {
  assessCertificates,
  formatFingerprint,
  observeCertificateChanges,
  presentedCertificates,
} from "../src/certificate-trust.js";
import type { CertificateChange } from "../src/certificate-trust.js";
import { bytesFromHex } from "./hex.js";

const HASH_BYTES = 32;
const NODE = "192.0.2.5:4433";
const hashHex = (digit: string): string => digit.repeat(HASH_BYTES * 2);

describe("assessCertificates", () => {
  it("is first use when nothing is remembered for the node", () => {
    expect(assessCertificates(NODE, [hashHex("a")], [])).toEqual({
      kind: "first-use",
      node: NODE,
      presented: [hashHex("a")],
    });
  });

  it("is known when any presented certificate is remembered, as a rotation looks", () => {
    expect(
      assessCertificates(
        NODE,
        [hashHex("b"), hashHex("c")],
        [hashHex("a"), hashHex("b")],
      ),
    ).toEqual({ kind: "known", node: NODE });
  });

  it("is changed when something is remembered and none of it is presented", () => {
    expect(
      assessCertificates(NODE, [hashHex("c")], [hashHex("a"), hashHex("b")]),
    ).toEqual({
      kind: "changed",
      node: NODE,
      remembered: [hashHex("a"), hashHex("b")],
      presented: [hashHex("c")],
    });
  });
});

describe("presentedCertificates", () => {
  it("reads the node and pins from a pinned address", () => {
    const presented = presentedCertificates(
      formatPinnedAddress(NODE, [hashHex("a"), hashHex("b")]),
    );

    expect(presented?.node).toBe(NODE);
    expect(presented?.sha256).toEqual([
      bytesFromHex(hashHex("a")),
      bytesFromHex(hashHex("b")),
    ]);
  });

  it("is undefined for an address with no pins, and for malformed pins", () => {
    expect(presentedCertificates("ws://192.0.2.5:8787")).toBeUndefined();
    expect(
      presentedCertificates("https://192.0.2.5:4433#sha256=nothex"),
    ).toBeUndefined();
  });
});

describe("observeCertificateChanges", () => {
  async function observed(): Promise<{
    memory: ReturnType<typeof observeCertificateChanges>;
    changes: CertificateChange[];
  }> {
    const base = createCertificateMemory(createMemoryStorage());
    await base.remember(NODE, [bytesFromHex(hashHex("a"))]);
    const changes: CertificateChange[] = [];
    const onChange = vi.fn<(change: Readonly<CertificateChange>) => void>(
      (change) => {
        changes.push(change);
      },
    );
    return { memory: observeCertificateChanges(base, onChange), changes };
  }

  it("reports a write that replaces the remembered set with a disjoint one, and still stores it", async () => {
    const { memory, changes } = await observed();

    await memory.remember(NODE, [bytesFromHex(hashHex("b"))]);

    expect(changes).toEqual([
      { node: NODE, remembered: [hashHex("a")], presented: [hashHex("b")] },
    ]);
    expect(await memory.recall(NODE)).toEqual([bytesFromHex(hashHex("b"))]);
  });

  it("stays silent for a rotation that keeps a remembered certificate, and for a first write", async () => {
    const { memory, changes } = await observed();

    await memory.remember(NODE, [
      bytesFromHex(hashHex("a")),
      bytesFromHex(hashHex("b")),
    ]);
    await memory.remember("192.0.2.9:4433", [bytesFromHex(hashHex("c"))]);

    expect(changes).toEqual([]);
  });
});

describe("formatFingerprint", () => {
  it("shows uppercase hex pairs separated by colons", () => {
    expect(formatFingerprint("0a1b2c")).toBe("0A:1B:2C");
  });
});
