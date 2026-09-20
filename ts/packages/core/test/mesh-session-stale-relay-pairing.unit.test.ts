import { describe, expect, it } from "vitest";
import { acceptMeshSession } from "../src/domain/mesh-session.js";
import type {
  CapabilityScope,
  RelayDataFrame,
} from "../src/generated/protocol.js";
import { tryDecodeFrame, wrapRelayData } from "../src/adapters/frame-codec.js";
import {
  FakeConnection,
  deviceB,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";

const SHORT_TIMEOUT_MS = 20;
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

    const answered = session.sendManageRequest(
      COMMAND,
      ROOM_SCOPE,
      deviceB,
      undefined,
      SHORT_TIMEOUT_MS,
    );
    const sent = await nextRelayData(fake);
    const request = tryDecodeFrame(sent.payload);
    expect(request?.type).toBe("manage-request");
    if (request?.type !== "manage-request") return;
    fake.push(
      wrapRelayData({
        type: "manage-response",
        "request-id": request["request-id"],
        outcome: { result: "ok" },
      }),
    );
    expect(await answered).toEqual({ result: "ok" });

    const unanswered = session.sendManageRequest(
      COMMAND,
      ROOM_SCOPE,
      deviceB,
      undefined,
      SHORT_TIMEOUT_MS,
    );
    await nextRelayData(fake, 1);
    expect(relayConnectsSent(fake)).toBe(1);
    await session.close();
    await expect(unanswered).rejects.toThrow("before a response arrived");
  });
});

/** Resolves with the relay-data frame the session has put on the wire at the given position (the first by default), waiting for it to appear. */
async function nextRelayData(
  fake: Readonly<FakeConnection>,
  index = 0,
): Promise<RelayDataFrame> {
  for (;;) {
    const frames = fake.sent.filter(
      (frame): frame is RelayDataFrame => frame.type === "relay-data",
    );
    const frame = frames[index];
    if (frame !== undefined) return frame;
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}
