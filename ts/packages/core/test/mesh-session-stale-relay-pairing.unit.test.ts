import { describe, expect, it } from "vitest";
import { acceptMeshSession } from "../src/domain/mesh-session.js";
import type { CapabilityScope } from "../src/generated/protocol.js";
import { RelayPeer } from "./relay-peer.js";
import {
  FakeConnection,
  deviceB,
  identityB,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";

const SHORT_TIMEOUT_MS = 20;
/** Long enough for a real secure-channel handshake to finish inside it, which a request that is going to be answered has to do. */
const ANSWERED_TIMEOUT_MS = 5000;
const ROOM_SCOPE: Readonly<CapabilityScope> = { kind: "room", path: "a/b" };
const COMMAND = { verb: "room:member", params: { verb: "room.send" } };

function relayConnectsSent(fake: Readonly<FakeConnection>): number {
  return fake.sent.filter((frame) => frame.type === "relay-connect").length;
}

describe("a relayed request that times out", () => {
  it("re-sends relay-connect on the next request to the same device, because the pairing it rode on may no longer exist at the hub", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/room"],
      { clock: testClock },
    );

    const first = await session.sendManageRequest(
      COMMAND,
      ROOM_SCOPE,
      deviceB,
      undefined,
      SHORT_TIMEOUT_MS,
    );
    expect(first).toEqual({ result: "error", code: "timeout" });
    expect(relayConnectsSent(fake)).toBe(1);

    await session.sendManageRequest(
      COMMAND,
      ROOM_SCOPE,
      deviceB,
      undefined,
      SHORT_TIMEOUT_MS,
    );
    expect(relayConnectsSent(fake)).toBe(2);

    await session.close();
  });

  it("keeps the pairing when the request is answered, so a healthy pairing is not re-established on every request", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/room"],
      { clock: testClock },
    );
    const peer = new RelayPeer(identityB, testIdentity, fake);

    const answered = session.sendManageRequest(
      COMMAND,
      ROOM_SCOPE,
      deviceB,
      undefined,
      ANSWERED_TIMEOUT_MS,
    );
    await peer.answerHello();
    const [request] = await peer.received();
    expect(request?.type).toBe("manage-request");
    if (request?.type !== "manage-request") return;
    await peer.deliver({
      type: "manage-response",
      "request-id": request["request-id"],
      outcome: { result: "ok" },
    });
    expect(await answered).toEqual({ result: "ok" });

    const unanswered = session.sendManageRequest(
      COMMAND,
      ROOM_SCOPE,
      deviceB,
      undefined,
      ANSWERED_TIMEOUT_MS,
    );
    await peer.received();
    expect(relayConnectsSent(fake)).toBe(1);
    await session.close();
    await expect(unanswered).rejects.toThrow("before a response arrived");
  });
});
