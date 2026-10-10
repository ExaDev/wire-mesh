import { describe, expect, it } from "vitest";
import {
  explainLocalNetworkBlock,
  isLocalNetworkHost,
  type PermissionQuerier,
} from "../src/local-network.js";

const PUBLIC_PAGE = "mesh.exadev.io";

function permissionAt(state: string): PermissionQuerier {
  return { query: async () => Promise.resolve({ state }) };
}

describe("isLocalNetworkHost", () => {
  it.each([
    "10.1.0.96",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.228",
    "169.254.10.10",
    "100.79.111.73",
    "127.0.0.1",
    "localhost",
    "mini.local",
    "mini",
    "[::1]",
    "fd12:3456::1",
    "fe80::1",
  ])("treats %s as local", (host) => {
    expect(isLocalNetworkHost(host)).toBe(true);
  });

  it.each([
    "mesh.exadev.io",
    "8.8.8.8",
    "172.32.0.1",
    "172.15.0.1",
    "100.128.0.1",
    "100.63.0.1",
    "192.169.0.1",
    "2606:4700::1111",
    "999.1.1.1",
  ])("treats %s as public", (host) => {
    expect(isLocalNetworkHost(host)).toBe(false);
  });
});

describe("explainLocalNetworkBlock", () => {
  it("explains a denied permission for a local address from a public page", async () => {
    const message = await explainLocalNetworkBlock(
      "https://192.168.1.228:4433#sha256=ab",
      PUBLIC_PAGE,
      permissionAt("denied"),
    );
    expect(message).toContain("192.168.1.228");
    expect(message).toContain("Local network access");
  });

  it("reads the host out of a bare host:port address too", async () => {
    expect(
      await explainLocalNetworkBlock(
        "10.1.0.96:8787",
        PUBLIC_PAGE,
        permissionAt("denied"),
      ),
    ).toContain("10.1.0.96");
  });

  it("says nothing when the permission is granted or still to be asked", async () => {
    await Promise.all(
      ["granted", "prompt"].map(async (state) => {
        expect(
          await explainLocalNetworkBlock(
            "ws://192.168.1.5:8787",
            PUBLIC_PAGE,
            permissionAt(state),
          ),
        ).toBeUndefined();
      }),
    );
  });

  it("says nothing for a public address, or when the page itself is on the local network", async () => {
    expect(
      await explainLocalNetworkBlock(
        "wss://mesh.exadev.io",
        PUBLIC_PAGE,
        permissionAt("denied"),
      ),
    ).toBeUndefined();
    expect(
      await explainLocalNetworkBlock(
        "ws://192.168.1.5:8787",
        "localhost",
        permissionAt("denied"),
      ),
    ).toBeUndefined();
  });

  it("says nothing in a browser that does not know the permission", async () => {
    const unsupported: PermissionQuerier = {
      query: async () =>
        Promise.reject(new TypeError("not a valid permission name")),
    };
    expect(
      await explainLocalNetworkBlock(
        "ws://192.168.1.5:8787",
        PUBLIC_PAGE,
        unsupported,
      ),
    ).toBeUndefined();
    expect(
      await explainLocalNetworkBlock(
        "ws://192.168.1.5:8787",
        PUBLIC_PAGE,
        undefined,
      ),
    ).toBeUndefined();
  });
});
