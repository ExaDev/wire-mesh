// The hub's control over what an advert's open extension tail may carry to every other client. Split from relay-hub.unit.test.ts under the same max-lines cap as its sibling files.

import { describe, expect, it, vi } from "vitest";
import { createRelayHub, type AdvertRefusal } from "../src/domain/relay-hub.js";
import { signPeerAdvert } from "../src/domain/peer-advert.js";
import type { AdvertExtensionPolicy } from "../src/domain/advert-extension-policy.js";
import type { PeerAdvert } from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import { generateEd25519Identity } from "./tokens-fixtures.js";
import {
  FakeConnection,
  FIXTURE_SNAPSHOT_SECONDS,
  gossipFor,
  hubVerifier,
  settle,
} from "./relay-hub-test-helpers.js";

/** A signed advert carrying the given extension entries, which is what a peer publishing application data on a hub sends. */
async function advertWith(
  identity: Readonly<IdentityPort>,
  extensions: Record<string, unknown>,
): Promise<PeerAdvert> {
  return signPeerAdvert(identity, {
    device: identity.deviceId,
    addresses: ["203.0.113.5:4433"],
    "snapshot-seconds": FIXTURE_SNAPSHOT_SECONDS,
    "identity-key": identity.identityKey,
    ...extensions,
  });
}

const isName = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value).length === 1 &&
  "name" in value &&
  typeof value.name === "string";

const policy: AdvertExtensionPolicy = {
  allowed: { "agent/self": isName },
};

function connect(hub: Readonly<ReturnType<typeof createRelayHub>>): {
  fake: FakeConnection;
  handling: Promise<void>;
} {
  const fake = new FakeConnection();
  return { fake, handling: hub.handleConnection(fake.connection) };
}

describe("createRelayHub: extension policy", () => {
  it("carries every extension when no policy is set", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const sender = await generateEd25519Identity();
    const advert = await advertWith(sender, {
      "agent/self": { name: "a", cwd: "/home/someone/project" },
    });
    const from = connect(hub);
    const to = connect(hub);

    from.fake.push(gossipFor(advert));
    await settle(from.fake, to.fake);

    expect(to.fake.sent).toEqual([gossipFor(advert)]);

    await Promise.all([from.fake.end(), to.fake.end()]);
    await Promise.all([from.handling, to.handling]);
  });

  it("forwards an advert whose extensions the policy allows, unchanged", async () => {
    const hub = createRelayHub({
      identity: hubVerifier,
      extensionPolicy: policy,
    });
    const sender = await generateEd25519Identity();
    const advert = await advertWith(sender, { "agent/self": { name: "a" } });
    const from = connect(hub);
    const to = connect(hub);

    from.fake.push(gossipFor(advert));
    await settle(from.fake, to.fake);

    expect(to.fake.sent).toEqual([gossipFor(advert)]);

    await Promise.all([from.fake.end(), to.fake.end()]);
    await Promise.all([from.handling, to.handling]);
  });

  it("refuses an advert holding an extension the policy does not list, reaching nobody", async () => {
    const onAdvertRefused = vi.fn<(refusal: Readonly<AdvertRefusal>) => void>();
    const hub = createRelayHub({
      identity: hubVerifier,
      extensionPolicy: policy,
      onAdvertRefused,
    });
    const sender = await generateEd25519Identity();
    const advert = await advertWith(sender, {
      "agent/self": { name: "a" },
      "room/hosted": [{ name: "private thing" }],
    });
    const from = connect(hub);
    const to = connect(hub);

    from.fake.push(gossipFor(advert));
    await settle(from.fake, to.fake);

    expect(to.fake.sent).toEqual([]);
    expect(onAdvertRefused).toHaveBeenCalledWith({
      device: sender.deviceId,
      key: "room/hosted",
    });

    await Promise.all([from.fake.end(), to.fake.end()]);
    await Promise.all([from.handling, to.handling]);
  });

  it("refuses an advert whose allowed extension carries a field its validator does not expect", async () => {
    const hub = createRelayHub({
      identity: hubVerifier,
      extensionPolicy: policy,
    });
    const sender = await generateEd25519Identity();
    const advert = await advertWith(sender, {
      "agent/self": { name: "a", cwd: "/home/someone/project" },
    });
    const from = connect(hub);
    const to = connect(hub);

    from.fake.push(gossipFor(advert));
    await settle(from.fake, to.fake);

    expect(to.fake.sent).toEqual([]);

    await Promise.all([from.fake.end(), to.fake.end()]);
    await Promise.all([from.handling, to.handling]);
  });

  it("does not replay a refused advert in a later client's catch-up", async () => {
    const hub = createRelayHub({
      identity: hubVerifier,
      extensionPolicy: policy,
    });
    const leaker = await generateEd25519Identity();
    const newcomer = await generateEd25519Identity();
    const refused = await advertWith(leaker, {
      "agent/self": { name: "a", cwd: "/home/someone/project" },
    });
    const allowedAdvert = await advertWith(newcomer, {});
    const from = connect(hub);
    const late = connect(hub);

    from.fake.push(gossipFor(refused));
    await settle(from.fake, late.fake);
    late.fake.push(gossipFor(allowedAdvert));
    await settle(from.fake, late.fake);

    expect(late.fake.sent).toEqual([]);

    await Promise.all([from.fake.end(), late.fake.end()]);
    await Promise.all([from.handling, late.handling]);
  });

  it("always carries wire-mesh-core's own extensions, with no entry in the policy", async () => {
    const hub = createRelayHub({
      identity: hubVerifier,
      extensionPolicy: { allowed: {} },
    });
    const sender = await generateEd25519Identity();
    const advert = await advertWith(sender, {
      "wire-mesh/version": "1.0.0",
      "topology/peers": { direct: [], relayed: [] },
    });
    const from = connect(hub);
    const to = connect(hub);

    from.fake.push(gossipFor(advert));
    await settle(from.fake, to.fake);

    expect(to.fake.sent).toEqual([gossipFor(advert)]);

    await Promise.all([from.fake.end(), to.fake.end()]);
    await Promise.all([from.handling, to.handling]);
  });

  it("treats an extension named like an inherited object property as unlisted", async () => {
    const hub = createRelayHub({
      identity: hubVerifier,
      extensionPolicy: { allowed: {} },
    });
    const sender = await generateEd25519Identity();
    const advert = await advertWith(sender, { "constructor/x": "y" });
    const from = connect(hub);
    const to = connect(hub);

    from.fake.push(gossipFor(advert));
    await settle(from.fake, to.fake);

    expect(to.fake.sent).toEqual([]);

    await Promise.all([from.fake.end(), to.fake.end()]);
    await Promise.all([from.handling, to.handling]);
  });
});
