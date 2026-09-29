import { describe, expect, it } from "vitest";
import { toWebSocketAddress } from "../src/dial-address.js";

describe("toWebSocketAddress", () => {
  it("dials a bare host:port over plain ws", () => {
    expect(toWebSocketAddress("192.0.2.5:8790")).toBe("ws://192.0.2.5:8790");
  });

  it.each(["ws://192.0.2.5:8790/", "wss://node.example:8790/"])(
    "dials %s as written",
    (address) => {
      expect(toWebSocketAddress(address)).toBe(address);
    },
  );

  it("dials an https address over wss and an http address over ws", () => {
    expect(toWebSocketAddress("https://node.example:8790")).toBe(
      "wss://node.example:8790/",
    );
    expect(toWebSocketAddress("http://192.0.2.5:8790")).toBe(
      "ws://192.0.2.5:8790/",
    );
  });

  it("drops the pin fragment a WebSocket URL cannot carry", () => {
    expect(toWebSocketAddress("https://192.0.2.5:4433#sha256=abc")).toBe(
      "wss://192.0.2.5:4433/",
    );
  });

  it("leaves a scheme no WebSocket transport can dial for the transport to refuse", () => {
    expect(toWebSocketAddress("ftp://node.example:21")).toBe(
      "ftp://node.example:21",
    );
  });
});
