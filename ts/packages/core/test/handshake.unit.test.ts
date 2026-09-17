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

  it("never negotiates a retired domain, even when both peers advertise it", () => {
    // core/federation is retired (handshake.cddl): a peer must never advertise or negotiate it. Two buggy peers both advertising it must still not end up speaking it.
    const result = negotiate(
      handshake(1, ["core/management", "core/federation"]),
      handshake(1, ["core/federation", "core/management"]),
    );
    expect(result.sharedDomains).toEqual(["core/management"]);
    expect(result.ok).toBe(true);
  });

  it("fails when the only shared domain is a retired one", () => {
    const result = negotiate(
      handshake(1, ["core/federation"]),
      handshake(1, ["core/federation"]),
    );
    expect(result.sharedDomains).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("succeeds when versions and domains both overlap", () => {
    const result = negotiate(
      handshake(1, ["core/management"]),
      handshake(1, ["core/management"]),
    );
    expect(result.ok).toBe(true);
  });
});
