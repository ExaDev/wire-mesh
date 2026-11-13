// The generator's check on its own output: a duplicate vector name or a name the section refers to that is not a vector fails generation, so a consumer never finds a dangling reference in a committed file.

import { type Vector } from "@exadev/wire-mesh-conformance";
import { describe, expect, it } from "vitest";
import {
  assertReferencesResolve,
  jsonArray,
  jsonField,
} from "./secure-channel-references.ts";

const first: Vector = { name: "first", message: null, wire_hex: "00" };
const vectors: Vector[] = [
  first,
  { name: "second", message: null, wire_hex: "01" },
];

describe("assertReferencesResolve", () => {
  it("accepts references to vectors that exist", () => {
    expect(() => {
      assertReferencesResolve(vectors, ["first", "second", "first"]);
    }).not.toThrow();
  });

  it("refuses a reference to a name that is not a vector", () => {
    expect(() => {
      assertReferencesResolve(vectors, ["first", "missing"]);
    }).toThrow(/missing is referred to but is not a vector/);
  });

  it("refuses two vectors with one name", () => {
    expect(() => {
      assertReferencesResolve([...vectors, first], []);
    }).toThrow(/two vectors are named first/);
  });
});

describe("jsonField and jsonArray", () => {
  it("read a string field and an array, and refuse anything else", () => {
    expect(jsonField({ a: "x" }, "a")).toBe("x");
    expect(() => jsonField({ a: 1 }, "a")).toThrow();
    expect(() => jsonField([], "a")).toThrow();
    expect(jsonArray([1])).toEqual([1]);
    expect(() => jsonArray({})).toThrow();
  });
});
