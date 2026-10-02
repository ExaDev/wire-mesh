// How a MeshSession carries core/data frames between two devices that reach each other only through a relay (spec/secure-channel.cddl): sealed on the channel with the addressed device, attributed on arrival to the identity that channel authenticated.

import { describe, expect, it } from "vitest";
import { messageFromFrame } from "../src/adapters/frame-codec.js";
import {
  createMeshSession,
  type DataDomainFrame,
  type IncomingDataFrame,
} from "../src/domain/mesh-session.js";
import {
  deviceA,
  deviceB,
  fakeTransport,
  identityA,
  identityB,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";
import { RelayPeer } from "./relay-peer.js";

const SETTLE_MS = 30;
const HEAD_SEQ = 4;
const FROM_SEQ = 2;

const have: DataDomainFrame = {
  type: "data-have",
  peer: deviceA,
  "head-seq": HEAD_SEQ,
};
const request: DataDomainFrame = {
  type: "data-request",
  peer: deviceA,
  "from-seq": FROM_SEQ,
};

async function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

async function connectedSession(): Promise<{
  session: ReturnType<typeof createMeshSession>;
  connection: ReturnType<typeof fakeTransport>["connection"];
  incoming: IncomingDataFrame[];
}> {
  const { transport, connection } = fakeTransport();
  const session = createMeshSession(transport, testIdentity, testClock);
  await session.connect("ws://node", ["core/data"]);
  const incoming: IncomingDataFrame[] = [];
  void (async (): Promise<void> => {
    for await (const received of session.incomingDataFrames) {
      incoming.push(received);
    }
  })();
  return { session, connection, incoming };
}

describe("core/data frames through a relay pairing", () => {
  it("seals a frame sent to a target device, never putting it on the wire in the clear", async () => {
    const { session, connection } = await connectedSession();
    const peer = new RelayPeer(identityA, testIdentity, connection);

    const sent = session.sendDataFrame(have, deviceA);
    await peer.answerHello();
    await sent;

    expect(await peer.received()).toEqual([have]);
    expect(connection.sent.map((frame) => frame.type)).not.toContain(
      "data-have",
    );
    expect(connection.sent.map((frame) => frame.type)).toContain(
      "relay-connect",
    );
    await session.close();
  });

  it("sends directly, with no pairing, when no target device is given", async () => {
    const { session, connection } = await connectedSession();

    await session.sendDataFrame(have);

    expect(connection.sent).toContainEqual(have);
    expect(connection.sent.map((frame) => frame.type)).not.toContain(
      "relay-connect",
    );
    await session.close();
  });

  it("delivers a sealed frame as coming from the device its channel authenticated", async () => {
    const { session, connection, incoming } = await connectedSession();
    const peerA = new RelayPeer(identityA, testIdentity, connection);
    const peerB = new RelayPeer(identityB, testIdentity, connection);
    await peerA.openTowardSession();
    await peerB.openTowardSession();

    await peerA.deliver(request, { stampedFrom: deviceB });
    await peerA.deliver(have, { toDevice: testIdentity.deviceId });
    await settle();

    expect(incoming).toEqual([
      { frame: have, fromDevice: deviceA, toDevice: testIdentity.deviceId },
    ]);
    await session.close();
  });

  it("drops a core/data frame delivered as plain relay-data", async () => {
    const { session, connection, incoming } = await connectedSession();
    const peer = new RelayPeer(identityA, testIdentity, connection);
    await peer.openTowardSession();

    connection.push({
      type: "relay-data",
      payload: messageFromFrame(have),
      "from-device": deviceA,
    });
    await settle();

    expect(incoming).toEqual([]);
    await session.close();
  });

  it("delivers a frame that arrived directly with no sender attributed", async () => {
    const { session, connection, incoming } = await connectedSession();

    connection.push(have);
    await settle();

    expect(incoming).toEqual([{ frame: have }]);
    await session.close();
  });

  it("answers a relayed data-have over the same pairing", async () => {
    const { session, connection, incoming } = await connectedSession();
    const peer = new RelayPeer(identityA, testIdentity, connection);
    await peer.openTowardSession();
    await peer.deliver(have);
    await settle();

    const [received] = incoming;
    if (received?.fromDevice === undefined) {
      throw new Error("expected an attributed data-have");
    }
    await session.sendDataFrame(request, received.fromDevice);

    expect(await peer.received()).toEqual([request]);
    await session.close();
  });
});
