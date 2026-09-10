import { describe, expect, it } from "vitest";
import { negotiate } from "../src/domain/handshake.js";
import type { HandshakeFrame } from "../src/generated/protocol.js";

function handshake(
  version: number,
  domains: readonly string[],
): HandshakeFrame {
  return { type: "handshake", version, domains: [...domains] };
}

describe("negotiate", () => {
  it("negotiates the lower of the two offered versions", () => {
    const result = negotiate(
      handshake(2, ["core/management"]),
      handshake(1, ["core/management"]),
    );
    expect(result.version).toBe(1);
  });

  it("negotiates the shared domains, in local order", () => {
    const result = negotiate(
      handshake(1, ["core/management", "core/exec", "core/data"]),
      handshake(1, ["core/data", "core/management"]),
    );
    expect(result.sharedDomains).toEqual(["core/management", "core/data"]);
  });

  it("fails when the two peers share no domains", () => {
    const result = negotiate(
      handshake(1, ["core/exec"]),
      handshake(1, ["core/data"]),
    );
    expect(result.ok).toBe(false);
    expect(result.sharedDomains).toEqual([]);
  });

  it("succeeds when versions and domains both overlap", () => {
    const result = negotiate(
      handshake(1, ["core/management"]),
      handshake(1, ["core/management"]),
    );
    expect(result.ok).toBe(true);
  });
});
