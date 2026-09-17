import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createIndexedDbStorage } from "../src/adapters/indexeddb-storage.js";
import { bytesFromHex } from "./hex.js";

function freshDbName(): string {
  return crypto.randomUUID();
}

describe("createIndexedDbStorage", () => {
  it("round-trips a set value through get", async () => {
    const storage = await createIndexedDbStorage({ dbName: freshDbName() });
    const value = bytesFromHex("010203");
    await storage.set("a", value);
    expect(await storage.get("a")).toEqual(value);
  });

  it("resolves undefined for a key that was never set", async () => {
    const storage = await createIndexedDbStorage({ dbName: freshDbName() });
    expect(await storage.get("missing")).toBeUndefined();
  });

  it("resolves undefined after deleting a key", async () => {
    const storage = await createIndexedDbStorage({ dbName: freshDbName() });
    await storage.set("a", bytesFromHex("01"));
    await storage.delete("a");
    expect(await storage.get("a")).toBeUndefined();
  });

  it("keys(prefix) returns exactly the matching keys among a mix of matching and non-matching ones", async () => {
    const storage = await createIndexedDbStorage({ dbName: freshDbName() });
    await storage.set("device/a", bytesFromHex("01"));
    await storage.set("device/b", bytesFromHex("02"));
    await storage.set("other/c", bytesFromHex("03"));

    const matched = await storage.keys("device/");
    expect(new Set(matched)).toEqual(new Set(["device/a", "device/b"]));
  });

  it("keys(prefix) includes keys containing BMP characters above the surrogate range (U+E000-U+FFFF) -- a \\u{10FFFF}-based upper bound would wrongly exclude exactly these, since that escape is a surrogate pair whose lead code unit (0xDBFF) sorts below them", async () => {
    const storage = await createIndexedDbStorage({ dbName: freshDbName() });
    const privateUseAreaKey = "prefix/\uE000";
    const replacementCharKey = "prefix/\uFFFD";
    const maxBmpKey = "prefix/\uFFFF";
    const supplementaryPlaneKey = "prefix/\u{10000}";
    await storage.set(privateUseAreaKey, bytesFromHex("01"));
    await storage.set(replacementCharKey, bytesFromHex("02"));
    await storage.set(maxBmpKey, bytesFromHex("03"));
    await storage.set(supplementaryPlaneKey, bytesFromHex("04"));

    const matched = await storage.keys("prefix/");
    expect(new Set(matched)).toEqual(
      new Set([
        privateUseAreaKey,
        replacementCharKey,
        maxBmpKey,
        supplementaryPlaneKey,
      ]),
    );
  });

  it("persists across independent instances sharing the same dbName -- proving it is genuinely IndexedDB-backed, not an accidental in-memory Map", async () => {
    const dbName = freshDbName();
    const value = bytesFromHex("090807");

    const instanceA = await createIndexedDbStorage({ dbName });
    await instanceA.set("shared", value);

    const instanceB = await createIndexedDbStorage({ dbName });
    expect(await instanceB.get("shared")).toEqual(value);
  });
});
