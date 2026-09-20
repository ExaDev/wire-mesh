import { describe, expect, it } from "vitest";
import type { GossipFrame, HandshakeFrame } from "../src/generated/protocol.js";
import { acceptMeshSession } from "../src/domain/mesh-session.js";
import {
  EVENTS_THROUGH_REMOTE_HANDSHAKE,
  FakeConnection,
  deviceA,
  deviceB,
  gossipFor,
  identityA,
  identityB,
  nthEvent,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";

describe("acceptMeshSession", () => {
  it("wires up handshake and self-advert immediately, with no dial step at all", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/data"],
      { clock: testClock, label: "peer-over-tcp" },
    );

    expect(fake.sent[0]).toEqual({
      type: "handshake",
      version: 1,
      domains: ["core/data"],
    } satisfies HandshakeFrame);
    const selfAdvert = fake.sent[1] as GossipFrame;
    expect(selfAdvert.peers[0]?.device).toEqual(testIdentity.deviceId);
    await session.close();
  });

  it("advertises this node's own given addresses in its self-advert", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/data"],
      { clock: testClock, addresses: ["192.168.1.10:9000"] },
    );

    const selfAdvert = fake.sent[1] as GossipFrame;
    expect(selfAdvert.peers[0]?.addresses).toEqual(["192.168.1.10:9000"]);
    await session.close();
  });

  it("advertises no addresses in its self-advert when none are given, rather than a stray default", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/data",
    ]);

    const selfAdvert = fake.sent[1] as GossipFrame;
    expect(selfAdvert.peers[0]?.addresses).toEqual([]);
    await session.close();
  });

  it("labels its connection state 'accepted' when no label is given", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/data"],
      { clock: testClock },
    );
    const event = (await nthEvent(session, 1)) as {
      state: { address: string };
    };
    expect(event.state.address).toBe("accepted");
    await session.close();
  });

  it("negotiates against the remote's own handshake exactly like the dial side", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/management",
      "core/data",
    ]);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    fake.push({
      type: "handshake",
      version: 1,
      domains: ["core/data", "core/exec"],
    });
    const event = (await eventsDone) as {
      state: {
        status: string;
        handshake: { status: string; sharedDomains: string[] };
      };
    };
    expect(event.state.status).toBe("connected");
    expect(event.state.handshake.status).toBe("negotiated");
    expect(event.state.handshake.sharedDomains).toEqual(["core/data"]);
    await session.close();
  });

  it("resolves peerDeviceId from the remote's own first self-advert", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/data",
    ]);
    fake.push(await gossipFor(identityB));
    await expect(session.peerDeviceId).resolves.toEqual(deviceB);
    await session.close();
  });

  it("peerDeviceId resolves from the first advert and never changes on a later one", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/data",
    ]);
    fake.push(await gossipFor(identityA));
    await expect(session.peerDeviceId).resolves.toEqual(deviceA);
    fake.push(await gossipFor(identityB));
    // Same promise, already settled -- a second, different advert cannot retroactively change what it resolved to.
    await expect(session.peerDeviceId).resolves.toEqual(deviceA);
    await session.close();
  });

  it("refuses connect(): the session is already connected by construction, with nothing to dial", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/data",
    ]);
    await expect(session.connect("ws://node", ["core/data"])).rejects.toThrow(
      "connects once",
    );
    await session.close();
  });

  it("close() closes the underlying connection and rejects pending manage-requests, same as the dial side", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/data",
    ]);
    const pending = session.sendManageRequest(
      { verb: "exec:proc", params: { verb: "exec.list" } },
      { kind: "folder" },
    );
    await session.close();
    await expect(pending).rejects.toThrow();
  });
});
