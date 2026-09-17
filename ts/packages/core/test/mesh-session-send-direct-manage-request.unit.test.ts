import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  ManageCommand,
  ManageRequestFrame,
  ManageResponseFrame,
} from "../src/generated/protocol.js";
import { sendDirectManageRequest } from "../src/domain/mesh-session.js";
import type { Connection, Transport } from "../src/ports/transport.js";
import {
  FakeConnection,
  deviceA,
  deviceB,
  TEST_TOKEN_SIGNATURE_BYTE,
} from "./mesh-session-fixtures.js";

const DIRECT_ADDRESS = "192.168.1.10:9000";
const TIMEOUT_MS = 5000;

async function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const testCommand: ManageCommand = {
  verb: "exec:proc",
  params: { verb: "exec.list" },
};
const testScope: CapabilityScope = { kind: "folder" };
const testToken: CapabilityToken = [
  new Uint8Array([1]),
  {},
  new Uint8Array([2]),
  new Uint8Array([TEST_TOKEN_SIGNATURE_BYTE]),
];

/** A one-shot Transport handing out a single FakeConnection for DIRECT_ADDRESS, optionally with a given (or absent) authenticated peerDeviceId -- mirrors what a real createTlsTransport().connect() would hand back. */
function directTransport(peerDeviceId?: DeviceId): {
  transport: Pick<Transport, "connect">;
  fake: FakeConnection;
} {
  const fake = new FakeConnection();
  const transport: Pick<Transport, "connect"> = {
    connect: async (address: string): Promise<Connection> => {
      if (address !== DIRECT_ADDRESS) {
        return Promise.reject(new Error(`connect to ${address} failed`));
      }
      return Promise.resolve({
        ...fake.connection,
        ...(peerDeviceId !== undefined ? { peerDeviceId } : {}),
      });
    },
  };
  return { transport, fake };
}

describe("sendDirectManageRequest", () => {
  it("sends exactly one manage-request over a fresh connection, with no handshake or gossip", async () => {
    const { transport, fake } = directTransport();
    const pending = sendDirectManageRequest(
      transport,
      DIRECT_ADDRESS,
      testCommand,
      testScope,
    );
    await tick();
    expect(fake.sent).toEqual([
      {
        type: "manage-request",
        "request-id": 0,
        command: testCommand,
        scope: testScope,
      },
    ] satisfies ManageRequestFrame[]);
    fake.push({
      type: "manage-response",
      "request-id": 0,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    await expect(pending).resolves.toEqual({ result: "ok" });
  });

  it("attaches the given token to the request", async () => {
    const { transport, fake } = directTransport();
    const pending = sendDirectManageRequest(
      transport,
      DIRECT_ADDRESS,
      testCommand,
      testScope,
      { token: testToken },
    );
    await tick();
    const sent = fake.sent[0] as ManageRequestFrame;
    expect(sent.token).toEqual(testToken);
    fake.push({
      type: "manage-response",
      "request-id": 0,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    await pending;
  });

  it("closes the connection once the correlated response arrives", async () => {
    const { transport, fake } = directTransport();
    const pending = sendDirectManageRequest(
      transport,
      DIRECT_ADDRESS,
      testCommand,
      testScope,
    );
    await tick();
    fake.push({
      type: "manage-response",
      "request-id": 0,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    await pending;
    expect(fake.isClosed).toBe(true);
  });

  it("ignores an unrelated frame arriving before the correlated response", async () => {
    const { transport, fake } = directTransport();
    const pending = sendDirectManageRequest(
      transport,
      DIRECT_ADDRESS,
      testCommand,
      testScope,
    );
    await tick();
    fake.push({ type: "ping" });
    fake.push({
      type: "manage-response",
      "request-id": 0,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    await expect(pending).resolves.toEqual({ result: "ok" });
  });

  it("proceeds when the connection's authenticated peerDeviceId matches the expected target", async () => {
    const { transport, fake } = directTransport(deviceA);
    const pending = sendDirectManageRequest(
      transport,
      DIRECT_ADDRESS,
      testCommand,
      testScope,
      { expectedPeerDeviceId: deviceA },
    );
    await tick();
    expect(fake.sent).toHaveLength(1);
    fake.push({
      type: "manage-response",
      "request-id": 0,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    await pending;
  });

  it("refuses and closes the connection when the authenticated peerDeviceId does not match the expected target", async () => {
    const { transport, fake } = directTransport(deviceB);
    await expect(
      sendDirectManageRequest(
        transport,
        DIRECT_ADDRESS,
        testCommand,
        testScope,
        {
          expectedPeerDeviceId: deviceA,
        },
      ),
    ).rejects.toThrow("does not match the expected target");
    expect(fake.sent).toEqual([]);
    expect(fake.isClosed).toBe(true);
  });

  it("proceeds without checking when the transport gives no authenticated peerDeviceId at all", async () => {
    const { transport, fake } = directTransport(undefined);
    const pending = sendDirectManageRequest(
      transport,
      DIRECT_ADDRESS,
      testCommand,
      testScope,
      { expectedPeerDeviceId: deviceA },
    );
    await tick();
    expect(fake.sent).toHaveLength(1);
    fake.push({
      type: "manage-response",
      "request-id": 0,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    await pending;
  });

  it("resolves with a timeout outcome and closes the connection when no response arrives within timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const { transport, fake } = directTransport();
      const pending = sendDirectManageRequest(
        transport,
        DIRECT_ADDRESS,
        testCommand,
        testScope,
        { timeoutMs: TIMEOUT_MS },
      );
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await expect(pending).resolves.toEqual({
        result: "error",
        code: "timeout",
      });
      expect(fake.isClosed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never times out when no timeoutMs is given", async () => {
    const { transport, fake } = directTransport();
    const pending = sendDirectManageRequest(
      transport,
      DIRECT_ADDRESS,
      testCommand,
      testScope,
    );
    await tick();
    fake.push({
      type: "manage-response",
      "request-id": 0,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    await expect(pending).resolves.toEqual({ result: "ok" });
  });
});
