// What a MeshSession does with the frames a relay hands it, now that everything through a pairing rides a secure channel (spec/secure-channel.cddl): only sealed frames are acted on, only as coming from the identity their channel authenticated, and a hub that lies about who sent one, or strips the protection, gets nowhere.

import { describe, expect, it } from "vitest";
import { messageFromFrame } from "../src/adapters/frame-codec.js";
import {
  createMeshSession,
  type IncomingManageRequest,
} from "../src/domain/mesh-session.js";
import { beginHandshake } from "../src/domain/secure-channel.js";
import type {
  CapabilityScope,
  ManageCommand,
  ManageRequestFrame,
  ManageResponseFrame,
} from "../src/generated/protocol.js";
import {
  deviceA,
  deviceB,
  deviceC,
  fakeTransport,
  identityA,
  identityB,
  identityC,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";
import { RelayPeer } from "./relay-peer.js";

const command: ManageCommand = {
  verb: "exec:proc",
  params: { verb: "exec.list" },
};
const scope: CapabilityScope = { kind: "folder" };
const FIRST_REQUEST_ID = 41;
const SECOND_REQUEST_ID = 42;
const SHORT_TIMEOUT_MS = 20;
/** Long enough for a real handshake to finish inside it. */
const ANSWERED_TIMEOUT_MS = 5000;
const SETTLE_MS = 30;
const UNREADABLE_CIPHERTEXT_BYTE_LENGTH = 32;

function requestFrame(requestId: number): ManageRequestFrame {
  return { type: "manage-request", "request-id": requestId, command, scope };
}

async function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

async function connectedSession(): Promise<{
  session: ReturnType<typeof createMeshSession>;
  connection: ReturnType<typeof fakeTransport>["connection"];
  incoming: IncomingManageRequest[];
}> {
  const { transport, connection } = fakeTransport();
  const session = createMeshSession(transport, testIdentity, testClock);
  await session.connect("ws://node", ["core/management"]);
  const incoming: IncomingManageRequest[] = [];
  void (async (): Promise<void> => {
    for await (const request of session.incomingManageRequests) {
      incoming.push(request);
    }
  })();
  return { session, connection, incoming };
}

describe("a session reached through a relay", () => {
  it("does not act on a manage-request delivered as plain relay-data", async () => {
    const { session, connection, incoming } = await connectedSession();
    const peer = new RelayPeer(identityA, testIdentity, connection);
    await peer.openTowardSession();

    connection.push({
      type: "relay-data",
      payload: messageFromFrame(requestFrame(FIRST_REQUEST_ID)),
      "from-device": deviceA,
    });
    await peer.deliver(requestFrame(SECOND_REQUEST_ID));
    await settle();

    expect(incoming.map((request) => request.requestId)).toEqual([
      SECOND_REQUEST_ID,
    ]);
    await session.close();
  });

  it("does not act on a sealed frame the relay stamped as coming from someone else", async () => {
    const { session, connection, incoming } = await connectedSession();
    const peerA = new RelayPeer(identityA, testIdentity, connection);
    const peerB = new RelayPeer(identityB, testIdentity, connection);
    await peerA.openTowardSession();
    await peerB.openTowardSession();

    await peerA.deliver(requestFrame(FIRST_REQUEST_ID), {
      stampedFrom: deviceB,
    });
    await peerA.deliver(requestFrame(SECOND_REQUEST_ID));
    await settle();

    expect(
      incoming.map((request) => [request.requestId, request.fromDevice]),
    ).toEqual([[SECOND_REQUEST_ID, deviceA]]);
    await session.close();
  });

  it("does not act on sealed data from a device it has no channel with", async () => {
    const { session, connection, incoming } = await connectedSession();
    const stranger = new RelayPeer(identityC, testIdentity, connection);
    connection.push({
      type: "relay-data",
      payload: messageFromFrame({
        type: "secure-data",
        counter: 0,
        ciphertext: new Uint8Array(UNREADABLE_CIPHERTEXT_BYTE_LENGTH),
      }),
      "from-device": deviceC,
    });
    await settle();

    expect(incoming).toEqual([]);
    expect(stranger.deviceId).toEqual(deviceC);
    await session.close();
  });

  it("ignores a hello addressed to another device, sending nothing back", async () => {
    const { session, connection } = await connectedSession();
    const forSomeoneElse = await beginHandshake(identityA, deviceB);
    const sentBefore = connection.sent.length;

    connection.push({ type: "relay-inbound", "source-device": deviceA });
    connection.push({
      type: "relay-data",
      payload: messageFromFrame(forSomeoneElse.hello),
      "from-device": deviceA,
    });
    await settle();

    expect(connection.sent.length).toBe(sentBefore);
    await session.close();
  });

  it("does not let one peer answer a request that was sent to another", async () => {
    const { session, connection } = await connectedSession();
    const peerA = new RelayPeer(identityA, testIdentity, connection);
    const peerB = new RelayPeer(identityB, testIdentity, connection);
    const pending = session.sendManageRequest(command, scope, deviceA);
    await peerA.answerHello();
    const [request] = await peerA.received();
    if (request?.type !== "manage-request") {
      throw new Error("expected the peer to receive a manage-request");
    }
    await peerB.openTowardSession();
    const forged: ManageResponseFrame = {
      type: "manage-response",
      "request-id": request["request-id"],
      outcome: { result: "error", code: "forged" },
    };

    await peerB.deliver(forged);
    await settle();
    await peerA.deliver({
      ...forged,
      outcome: { result: "ok" },
    });

    expect(await pending).toEqual({ result: "ok" });
    await session.close();
  });

  it("keeps working when the peer starts over with a new handshake", async () => {
    const { session, connection, incoming } = await connectedSession();
    const before = new RelayPeer(identityA, testIdentity, connection);
    await before.openTowardSession();
    await before.deliver(requestFrame(FIRST_REQUEST_ID));

    const restarted = new RelayPeer(identityA, testIdentity, connection);
    await restarted.openTowardSession();
    await restarted.deliver(requestFrame(SECOND_REQUEST_ID));
    await settle();

    expect(incoming.map((request) => request.requestId)).toEqual([
      FIRST_REQUEST_ID,
      SECOND_REQUEST_ID,
    ]);
    const second = incoming[1];
    if (second === undefined) throw new Error("no second request");
    await second.respond({ result: "ok" });
    expect(await restarted.received()).toEqual([
      {
        type: "manage-response",
        "request-id": SECOND_REQUEST_ID,
        outcome: { result: "ok" },
      },
    ]);
    await session.close();
  });

  it("times a request out when the peer never answers the handshake", async () => {
    const { session } = await connectedSession();

    const outcome = await session.sendManageRequest(
      command,
      scope,
      deviceA,
      undefined,
      SHORT_TIMEOUT_MS,
    );

    expect(outcome).toEqual({ result: "error", code: "timeout" });
    await session.close();
  });

  it("answers within the timeout once the peer completes the handshake", async () => {
    const { session, connection } = await connectedSession();
    const peer = new RelayPeer(identityA, testIdentity, connection);

    const pending = session.sendManageRequest(
      command,
      scope,
      deviceA,
      undefined,
      ANSWERED_TIMEOUT_MS,
    );
    await peer.answerHello();
    const [request] = await peer.received();
    if (request?.type !== "manage-request") {
      throw new Error("expected the peer to receive a manage-request");
    }
    await peer.deliver({
      type: "manage-response",
      "request-id": request["request-id"],
      outcome: { result: "ok" },
    });

    expect(await pending).toEqual({ result: "ok" });
    await session.close();
  });
});
