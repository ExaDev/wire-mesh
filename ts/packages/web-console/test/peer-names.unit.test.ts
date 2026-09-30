import { describe, expect, it } from "vitest";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import {
  MAX_NAME_LENGTH,
  SHORT_ID_LENGTH,
  cleanName,
  labelPeer,
  selfAssertedName,
  selfNameExtension,
  shortId,
} from "../src/peer-names.js";
import { syntheticAdvertProof } from "./synthetic-advert.js";
import { bytesFromHex } from "./hex.js";

const DEVICE_ID_BYTES = 32;
const DEVICE_HEX = "ab".repeat(DEVICE_ID_BYTES);
const OVERLONG_EXTRA = 1;

function advertWith(extension: Record<string, unknown>): PeerAdvert {
  return {
    device: bytesFromHex(DEVICE_HEX),
    addresses: [],
    "snapshot-seconds": 0,
    ...syntheticAdvertProof(),
    ...extension,
  };
}

describe("shortId", () => {
  it("is the leading characters of the device-id", () => {
    expect(shortId(DEVICE_HEX)).toBe(DEVICE_HEX.slice(0, SHORT_ID_LENGTH));
  });
});

describe("cleanName", () => {
  it("trims and bounds a name", () => {
    expect(cleanName("  Ada  ")).toBe("Ada");
    expect(
      cleanName("x".repeat(MAX_NAME_LENGTH + OVERLONG_EXTRA)),
    ).toHaveLength(MAX_NAME_LENGTH);
  });

  it("rejects a blank name", () => {
    expect(cleanName("   ")).toBeUndefined();
  });
});

describe("selfAssertedName", () => {
  it("reads the name from the agent/self extension", () => {
    expect(selfAssertedName(advertWith(selfNameExtension("Ada")))).toBe("Ada");
  });

  it("is undefined for an advert with no claim, a malformed claim or a blank name", () => {
    expect(selfAssertedName(advertWith({}))).toBeUndefined();
    expect(
      selfAssertedName(advertWith({ "agent/self": "Ada" })),
    ).toBeUndefined();
    expect(
      selfAssertedName(advertWith({ "agent/self": { name: 3 } })),
    ).toBeUndefined();
    expect(
      selfAssertedName(advertWith({ "agent/self": { name: " " } })),
    ).toBeUndefined();
  });

  it("bounds a long claimed name", () => {
    const name = selfAssertedName(
      advertWith(selfNameExtension("n".repeat(MAX_NAME_LENGTH * 2))),
    );
    expect(name).toHaveLength(MAX_NAME_LENGTH);
  });
});

describe("labelPeer", () => {
  it("prefers the petname and shows the peer's own claim beside it", () => {
    expect(labelPeer(DEVICE_HEX, "Ada", "ada-laptop")).toEqual({
      primary: "Ada",
      secondary: "ada-laptop",
      source: "petname",
    });
  });

  it("omits the secondary text when the petname equals the claim or there is no claim", () => {
    expect(labelPeer(DEVICE_HEX, "Ada", "Ada").secondary).toBeUndefined();
    expect(labelPeer(DEVICE_HEX, "Ada", undefined).secondary).toBeUndefined();
  });

  it("falls back to the self-asserted name, with the short id beside it", () => {
    expect(labelPeer(DEVICE_HEX, undefined, "ada-laptop")).toEqual({
      primary: "ada-laptop",
      secondary: shortId(DEVICE_HEX),
      source: "self",
    });
  });

  it("falls back to the short id when nothing names the peer", () => {
    expect(labelPeer(DEVICE_HEX, undefined, undefined)).toEqual({
      primary: shortId(DEVICE_HEX),
      secondary: undefined,
      source: "id",
    });
  });
});

describe("selfNameExtension", () => {
  it("carries the name under the key and shape the public hub's advert policy accepts", () => {
    expect(selfNameExtension("Ada")).toEqual({
      "agent/self": { name: "Ada", harness: "wire-mesh-console" },
    });
  });
});
