import { describe, expect, it, vi } from "vitest";
import { deviceIdToHex } from "../src/domain/device-id.js";
import { createRelayHub } from "../src/domain/relay-hub.js";
import { acceptMeshSession } from "../src/domain/mesh-session.js";
import type { SessionEvent } from "../src/domain/mesh-session.js";
import { hubVerifier } from "./relay-hub-test-helpers.js";
import {
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

// The event index a gossip frame lands at, for an acceptMeshSession that has advertised no local domains beyond the one given at construction: connected, self-advert-sent, then this frame's own applyFrame tick.
const EVENT_INDEX_AFTER_ONE_GOSSIP = 3;

/** One macrotask turn, letting a session's own consume loop finish processing whatever frame was just pushed. */
async function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("acceptMeshSession's onFrame/onSessionEnd hooks", () => {
  it("calls onFrame once per received frame, alongside the session's own applyFrame handling", async () => {
    const onFrame = vi.fn(async (): Promise<void> => Promise.resolve());
    const fake = new FakeConnection();
    const connection = fake.connection;
    const session = await acceptMeshSession(
      connection,
      testIdentity,
      ["core/data"],
      { clock: testClock, onFrame },
    );

    const gossip = await gossipFor(identityA);
    fake.push(gossip);
    // Waited on rather than a fixed number of turns: the session verifies the advert's signature before onFrame runs, and that completes on a later macrotask than the push.
    await vi.waitFor(() => {
      expect(onFrame).toHaveBeenCalledWith(connection, gossip);
    });
    await session.close();
  });

  it("still applies the frame to the session's own directory when onFrame is given -- it observes, it never replaces applyFrame", async () => {
    const onFrame = vi.fn(async (): Promise<void> => Promise.resolve());
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/data"],
      { clock: testClock, onFrame },
    );

    fake.push(await gossipFor(identityA));
    const event = (await nthEvent(
      session,
      EVENT_INDEX_AFTER_ONE_GOSSIP,
    )) as SessionEvent;

    expect(
      event.directory.map((entry) => deviceIdToHex(entry.device)),
    ).toContain(deviceIdToHex(deviceA));
    await session.close();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("does not require onFrame at all -- omitting it behaves exactly as before", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/data"],
      { clock: testClock },
    );

    fake.push(await gossipFor(identityA));
    await session.close();
  });

  it("calls onSessionEnd once the connection's own receive() stream ends", async () => {
    const onSessionEnd = vi.fn((): void => undefined);
    const fake = new FakeConnection();
    const connection = fake.connection;
    await acceptMeshSession(connection, testIdentity, ["core/data"], {
      clock: testClock,
      onSessionEnd,
    });

    fake.endStream();
    await tick();

    expect(onSessionEnd).toHaveBeenCalledWith(connection);
  });

  it("propagates a thrown onFrame error the same way any other frame-processing failure already surfaces, rather than silently swallowing it", async () => {
    const onFrame = vi.fn((): void => {
      throw new Error("relay forward failed");
    });
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/data"],
      { clock: testClock, onFrame },
    );

    fake.push(await gossipFor(identityA));
    await vi.waitFor(() => {
      expect(onFrame).toHaveBeenCalled();
    });
    await session.close();
  });

  it("wires a real RelayHub into a real MeshSession over one connection (wire-mesh#102): a gossip frame updates the session's own directory AND gets forwarded by the hub to another registered connection, from one shared consumption loop", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const meshFake = new FakeConnection();
    const otherPeerFake = new FakeConnection();
    const meshConnection = meshFake.connection;
    hub.registerConnection(meshConnection);
    hub.registerConnection(otherPeerFake.connection);

    const session = await acceptMeshSession(
      meshConnection,
      testIdentity,
      ["core/management"],
      {
        clock: testClock,
        onFrame: hub.onFrame,
        onSessionEnd: hub.onDisconnect,
      },
    );

    meshFake.push(await gossipFor(identityB));
    const event = (await nthEvent(
      session,
      EVENT_INDEX_AFTER_ONE_GOSSIP,
    )) as SessionEvent;

    // The session's own manage-request-capable directory saw the gossip (applyFrame's own job)...
    expect(
      event.directory.map((entry) => deviceIdToHex(entry.device)),
    ).toContain(deviceIdToHex(deviceB));
    // ...and the SAME frame also reached the relay hub, which forwarded it on to the other registered peer -- both consumers observed the identical frame from the one connection.receive() loop this session owns, with no second, competing for-await anywhere.
    expect(otherPeerFake.sent).toEqual([await gossipFor(identityB)]);

    await session.close();
  });
});
