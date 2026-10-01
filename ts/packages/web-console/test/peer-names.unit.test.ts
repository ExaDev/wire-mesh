import { describe, expect, it } from "vitest";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import {
  MAX_NAME_LENGTH,
  SHORT_ID_LENGTH,
  cleanName,
  labelPeer,
  labelText,
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

  it("strips control and bidirectional formatting characters", () => {
    expect(cleanName("A\u202Eda\u0000\u2066!\u200F")).toBe("Ada!");
    expect(cleanName("\u202E\u0007")).toBeUndefined();
  });

  it("keeps the zero-width joiner that emoji sequences need", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(cleanName(family)).toBe(family);
  });

  it("bounds by code point, never cutting a surrogate pair", () => {
    const name = cleanName(
      "\u{1F600}".repeat(MAX_NAME_LENGTH + OVERLONG_EXTRA),
    );
    expect(Array.from(name ?? "")).toHaveLength(MAX_NAME_LENGTH);
    expect(name).toBe("\u{1F600}".repeat(MAX_NAME_LENGTH));
  });

  it("leaves no trailing space when the length cut lands after a space", () => {
    const name = `${"a".repeat(MAX_NAME_LENGTH - 1)} b`;
    expect(cleanName(name)).toBe("a".repeat(MAX_NAME_LENGTH - 1));
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

const NO_PETNAMES: ReadonlySet<string> = new Set();

describe("labelPeer", () => {
  it("prefers the petname and shows the peer's own claim beside it", () => {
    expect(labelPeer(DEVICE_HEX, "Ada", "ada-laptop", NO_PETNAMES)).toEqual({
      primary: "Ada",
      secondary: "ada-laptop",
      source: "petname",
      matchesPetname: false,
    });
  });

  it("omits the secondary text when the petname equals the claim or there is no claim", () => {
    expect(
      labelPeer(DEVICE_HEX, "Ada", "Ada", NO_PETNAMES).secondary,
    ).toBeUndefined();
    expect(
      labelPeer(DEVICE_HEX, "Ada", undefined, NO_PETNAMES).secondary,
    ).toBeUndefined();
  });

  it("falls back to the self-asserted name, with the short id beside it", () => {
    expect(labelPeer(DEVICE_HEX, undefined, "ada-laptop", NO_PETNAMES)).toEqual(
      {
        primary: "ada-laptop",
        secondary: shortId(DEVICE_HEX),
        source: "self",
        matchesPetname: false,
      },
    );
  });

  it("falls back to the short id when nothing names the peer", () => {
    expect(labelPeer(DEVICE_HEX, undefined, undefined, NO_PETNAMES)).toEqual({
      primary: shortId(DEVICE_HEX),
      secondary: undefined,
      source: "id",
      matchesPetname: false,
    });
  });

  it("flags a self-asserted name that copies a petname held for any device", () => {
    const held = new Set(["Ada"]);
    expect(labelPeer(DEVICE_HEX, undefined, "Ada", held).matchesPetname).toBe(
      true,
    );
    expect(labelPeer(DEVICE_HEX, undefined, "Grace", held).matchesPetname).toBe(
      false,
    );
  });
});

describe("selfNameExtension", () => {
  it("carries the name under the key and shape the public hub's advert policy accepts", () => {
    expect(selfNameExtension("Ada")).toEqual({
      "agent/self": { name: "Ada", harness: "wire-mesh-console" },
    });
  });
});

describe("labelText", () => {
  it("puts the short id beside a self-asserted name", () => {
    expect(
      labelText(labelPeer(DEVICE_HEX, undefined, "Ada", NO_PETNAMES)),
    ).toBe(`Ada (${shortId(DEVICE_HEX)})`);
  });

  it("shows a petname or a short id alone", () => {
    expect(labelText(labelPeer(DEVICE_HEX, "Grace", "Ada", NO_PETNAMES))).toBe(
      "Grace",
    );
    expect(
      labelText(labelPeer(DEVICE_HEX, undefined, undefined, NO_PETNAMES)),
    ).toBe(shortId(DEVICE_HEX));
  });
});
