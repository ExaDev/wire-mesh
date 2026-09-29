import { describe, expect, it } from "vitest";
import { checkAdvertExtensions } from "wire-mesh-core/domain/advert-extension-policy";
import { signPeerAdvert } from "wire-mesh-core/domain/peer-advert";
import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { publicHubAdvertPolicy } from "../src/advert-policy.js";

const SNAPSHOT_SECONDS = 1861833600;

async function advertWith(
  extensions: Record<string, unknown>,
): Promise<PeerAdvert> {
  const identity = await createWebCryptoIdentity();
  return signPeerAdvert(identity, {
    device: identity.deviceId,
    addresses: ["203.0.113.5:4433"],
    "snapshot-seconds": SNAPSHOT_SECONDS,
    "identity-key": identity.identityKey,
    ...extensions,
  });
}

describe("publicHubAdvertPolicy", () => {
  it("carries the minimal agent advert, its presence and its versions", async () => {
    const advert = await advertWith({
      "agent/self": { name: "a", harness: "claude-code", membership: "proof" },
      "presence/status": "active",
      "agent-comms/version": { agentComms: "1.0.0", ccPeer: "2.0.0" },
      "wire-mesh/version": "1.0.0",
    });

    expect(checkAdvertExtensions(advert, publicHubAdvertPolicy)).toEqual({
      ok: true,
    });
  });

  it("carries an advert with no extensions at all", async () => {
    expect(
      checkAdvertExtensions(await advertWith({}), publicHubAdvertPolicy),
    ).toEqual({ ok: true });
  });

  it.each([
    ["a working directory", { name: "a", harness: "h", cwd: "/home/x/p" }],
    ["a process id", { name: "a", harness: "h", pid: 1234 }],
    ["joined rooms", { name: "a", harness: "h", subscribedRooms: ["r"] }],
    ["tags", { name: "a", harness: "h", tags: ["t"] }],
    ["no name", { harness: "h" }],
    ["a non-string name", { name: 1, harness: "h" }],
  ])("refuses an agent advert with %s", async (_label, agentSelf) => {
    const advert = await advertWith({ "agent/self": agentSelf });

    expect(checkAdvertExtensions(advert, publicHubAdvertPolicy)).toEqual({
      ok: false,
      key: "agent/self",
    });
  });

  it("carries public rooms by path and name", async () => {
    const advert = await advertWith({
      "room/hosted": [{ path: "p", name: "n", type: "public" }],
    });

    expect(checkAdvertExtensions(advert, publicHubAdvertPolicy)).toEqual({
      ok: true,
    });
  });

  it.each([
    ["a private room", [{ path: "p", name: "n", type: "private" }]],
    [
      "a room description",
      [{ path: "p", name: "n", type: "public", description: "d" }],
    ],
    ["something that is not a list", { path: "p", name: "n", type: "public" }],
  ])("refuses hosted rooms with %s", async (_label, rooms) => {
    const advert = await advertWith({ "room/hosted": rooms });

    expect(checkAdvertExtensions(advert, publicHubAdvertPolicy)).toEqual({
      ok: false,
      key: "room/hosted",
    });
  });

  it("refuses a presence value that is not a known status", async () => {
    const advert = await advertWith({ "presence/status": "at /home/x/p" });

    expect(checkAdvertExtensions(advert, publicHubAdvertPolicy)).toEqual({
      ok: false,
      key: "presence/status",
    });
  });

  it("refuses a version advert with a field it does not know", async () => {
    const advert = await advertWith({
      "agent-comms/version": { agentComms: "1", note: "x" },
    });

    expect(checkAdvertExtensions(advert, publicHubAdvertPolicy)).toEqual({
      ok: false,
      key: "agent-comms/version",
    });
  });
});
