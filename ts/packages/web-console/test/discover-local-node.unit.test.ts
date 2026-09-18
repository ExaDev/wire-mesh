import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WIRE_MESH_NODE_DEFAULT_PORT,
  discoverLocalNode,
  isLocalOrigin,
  probeLocalNode,
} from "../src/discover-local-node.js";

describe("isLocalOrigin", () => {
  it("matches bare localhost", () => {
    expect(isLocalOrigin("localhost")).toBe(true);
  });

  it("matches localhost with a port", () => {
    expect(isLocalOrigin("localhost:5173")).toBe(true);
  });

  it("matches a loopback IPv4 address with a port", () => {
    expect(isLocalOrigin("127.0.0.1:8787")).toBe(true);
  });

  it("does not match a remote host", () => {
    expect(isLocalOrigin("mesh.exadev.io")).toBe(false);
  });
});

describe("probeLocalNode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves to the default port's ws address when the fetch succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));

    await expect(probeLocalNode()).resolves.toBe(
      `ws://127.0.0.1:${String(WIRE_MESH_NODE_DEFAULT_PORT)}`,
    );
  });

  it("resolves to undefined when the fetch rejects (nothing listening)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    await expect(probeLocalNode()).resolves.toBeUndefined();
  });

  it("probes the given port instead of the default when one is passed", async () => {
    const ALTERNATE_PORT = 9000;
    const fetchSpy = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", fetchSpy);

    await expect(probeLocalNode(ALTERNATE_PORT)).resolves.toBe(
      "ws://127.0.0.1:9000",
    );
    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:9000/", {
      mode: "no-cors",
    });
  });
});

describe("discoverLocalNode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not probe the network when the host is already local", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(discoverLocalNode("localhost:5173")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("probes localhost when the host is remote and a node answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));

    await expect(discoverLocalNode("mesh.exadev.io")).resolves.toBe(
      `ws://127.0.0.1:${String(WIRE_MESH_NODE_DEFAULT_PORT)}`,
    );
  });

  it("resolves to undefined when the host is remote and nothing answers locally", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    await expect(discoverLocalNode("mesh.exadev.io")).resolves.toBeUndefined();
  });
});
