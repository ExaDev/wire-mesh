import { describe, expect, it } from "vitest";
import {
  dmRoomPath,
  ownerNamedRoomPath,
  parseRoomPath,
  slugRoomName,
} from "../src/domain/room-path.js";

const DEVICE_ID_HEX_LENGTH = 64;
const OWNER = "1".repeat(DEVICE_ID_HEX_LENGTH);
const OTHER = "2".repeat(DEVICE_ID_HEX_LENGTH);

describe("ownerNamedRoomPath", () => {
  it("joins the owner and local name with a slash", () => {
    expect(ownerNamedRoomPath(OWNER, "general")).toBe(`${OWNER}/general`);
  });

  it("rejects an owner that isn't 64-character lowercase hex", () => {
    expect(() => ownerNamedRoomPath("not-hex", "general")).toThrow();
  });

  it("rejects a local name outside [A-Za-z0-9_-]+", () => {
    expect(() => ownerNamedRoomPath(OWNER, "has spaces")).toThrow();
    expect(() => ownerNamedRoomPath(OWNER, "has.dots")).toThrow();
  });
});

describe("dmRoomPath", () => {
  it("joins the bytewise-ascending sorted pair with a plus", () => {
    expect(dmRoomPath(OWNER, OTHER)).toBe(`${OWNER}+${OTHER}`);
    expect(dmRoomPath(OTHER, OWNER)).toBe(`${OWNER}+${OTHER}`);
  });

  it("refuses to name the same device twice", () => {
    expect(() => dmRoomPath(OWNER, OWNER)).toThrow();
  });

  it("rejects a participant that isn't 64-character lowercase hex", () => {
    expect(() => dmRoomPath("not-hex", OTHER)).toThrow();
  });
});

describe("parseRoomPath", () => {
  it("recognises an owner-named path", () => {
    expect(parseRoomPath(`${OWNER}/general`)).toEqual({
      kind: "owner-named",
      owner: OWNER,
      localName: "general",
    });
  });

  it("recognises a DM path", () => {
    expect(parseRoomPath(`${OWNER}+${OTHER}`)).toEqual({
      kind: "dm",
      participants: [OWNER, OTHER],
    });
  });

  it("rejects a path shaped like neither", () => {
    expect(() => parseRoomPath("just-a-name")).toThrow();
  });
});

describe("slugRoomName", () => {
  it("replaces every character outside [A-Za-z0-9_-] with a hyphen", () => {
    expect(slugRoomName("documents.js")).toBe("documents-js");
    expect(slugRoomName("my project")).toBe("my-project");
  });

  it("leaves an already-valid name unchanged", () => {
    expect(slugRoomName("agent-comms_2")).toBe("agent-comms_2");
  });

  it("rejects a name with nothing left to slug", () => {
    expect(() => slugRoomName("...")).toThrow();
  });
});
