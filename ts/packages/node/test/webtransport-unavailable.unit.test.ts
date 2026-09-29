import { describe, expect, it, vi } from "vitest";
import {
  createWebTransportTransport,
  WebTransportUnavailableError,
} from "../src/adapters/webtransport-transport.js";

// The native package throws when its binary is not where it expects it, as it does when an install script was skipped.
vi.mock("@fails-components/webtransport-transport-http3-quiche", () => {
  throw new Error("Cannot find module '../build/Release/webtransport.node'");
});

describe("createWebTransportTransport without the native binary", () => {
  it("rejects listen with WebTransportUnavailableError rather than starting a listener that serves nothing", async () => {
    await expect(
      createWebTransportTransport().listen("127.0.0.1:0", () => undefined),
    ).rejects.toBeInstanceOf(WebTransportUnavailableError);
  });
});
