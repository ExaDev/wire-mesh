import { describe, expect, it } from "vitest";
import { toDialAddress } from "../src/dial-address.js";

/** The length of a SHA-256 digest in bytes. */
const HASH_BYTES = 32;
const SHA256_HEX = "ab".repeat(HASH_BYTES);

describe("toDialAddress", () => {
  it("dials a bare host:port over plain ws", () => {
    expect(toDialAddress("192.0.2.5:8790")).toBe("ws://192.0.2.5:8790");
  });

  it.each(["ws://192.0.2.5:8790/", "wss://node.example:8790/"])(
    "dials %s as written",
    (address) => {
      expect(toDialAddress(address)).toBe(address);
    },
  );

  it("dials an https address over wss and an http address over ws", () => {
    expect(toDialAddress("https://node.example:8790")).toBe(
      "wss://node.example:8790/",
    );
    expect(toDialAddress("http://192.0.2.5:8790")).toBe("ws://192.0.2.5:8790/");
  });

  it("returns a pinned address as it is, for WebTransport", () => {
    const pinned = `https://192.0.2.5:4433#sha256=${SHA256_HEX}`;
    expect(toDialAddress(pinned)).toBe(pinned);
  });

  it("drops a fragment a WebSocket URL cannot carry", () => {
    expect(toDialAddress("https://192.0.2.5:4433#other")).toBe(
      "wss://192.0.2.5:4433/",
    );
  });

  it("leaves a scheme no WebSocket transport can dial for the transport to refuse", () => {
    expect(toDialAddress("ftp://node.example:21")).toBe(
      "ftp://node.example:21",
    );
  });
});
