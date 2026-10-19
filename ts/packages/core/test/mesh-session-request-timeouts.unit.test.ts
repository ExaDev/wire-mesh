import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMeshSession } from "../src/domain/mesh-session.js";
import type {
  ManageCommand,
  ManageRequestFrame,
} from "../src/generated/protocol.js";
import {
  fakeTransport,
  MANAGE_REQUEST_TIMEOUT_MS,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";

const command: ManageCommand = {
  verb: "exec:proc",
  params: { verb: "exec.list" },
};
const scope = { kind: "folder" } as const;
const sessions: ReturnType<typeof createMeshSession>[] = [];

async function connected() {
  const { transport, connection } = fakeTransport();
  const link = connection.connection;
  const session = createMeshSession(
    { ...transport, connect: async () => Promise.resolve(link) },
    testIdentity,
    testClock,
  );
  sessions.push(session);
  await session.connect("ws://node", ["core/management"]);

  return { session, connection, link };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async (session) => session.close()));
  vi.useRealTimers();
});

describe("manage-request timeout cleanup", () => {
  it.each([
    { result: "ok" } as const,
    { result: "error", code: "denied" } as const,
  ])("clears the timer after a response: %j", async (outcome) => {
    const { session, connection } = await connected();
    const baseline = vi.getTimerCount();
    const pending = session.sendManageRequest(
      command,
      scope,
      undefined,
      undefined,
      MANAGE_REQUEST_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(0);
    const sent = connection.sent.at(-1) as ManageRequestFrame;
    connection.push({
      type: "manage-response",
      "request-id": sent["request-id"],
      outcome,
    });
    await expect(pending).resolves.toEqual(outcome);
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("clears the timer when the session closes before the response", async () => {
    const { session } = await connected();
    const pending = session.sendManageRequest(
      command,
      scope,
      undefined,
      undefined,
      MANAGE_REQUEST_TIMEOUT_MS,
    );
    const rejected = expect(pending).rejects.toThrow(
      "connection closed before a response arrived",
    );
    await session.close();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the connection drops", async () => {
    const { session, connection } = await connected();
    const pending = session.sendManageRequest(
      command,
      scope,
      undefined,
      undefined,
      MANAGE_REQUEST_TIMEOUT_MS,
    );
    const rejected = expect(pending).rejects.toThrow(
      "disconnected before a response arrived",
    );
    connection.fail(new Error("dropped"));
    await rejected;
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when transmission fails", async () => {
    const { session, link } = await connected();
    const baseline = vi.getTimerCount();
    vi.spyOn(link, "send").mockRejectedValueOnce(new Error("write failed"));
    await expect(
      session.sendManageRequest(
        command,
        scope,
        undefined,
        undefined,
        MANAGE_REQUEST_TIMEOUT_MS,
      ),
    ).rejects.toThrow("write failed");
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("clears only the answered request's timer while another can still time out", async () => {
    const { session, connection } = await connected();
    const baseline = vi.getTimerCount();
    const first = session.sendManageRequest(
      command,
      scope,
      undefined,
      undefined,
      MANAGE_REQUEST_TIMEOUT_MS,
    );
    const second = session.sendManageRequest(
      command,
      scope,
      undefined,
      undefined,
      MANAGE_REQUEST_TIMEOUT_MS,
    );
    const secondOutcome = second.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const requests = connection.sent.filter(
      (frame): frame is ManageRequestFrame => frame.type === "manage-request",
    );
    expect(requests).toHaveLength(2);
    const request = requests[0];
    if (request === undefined) throw new Error("missing request");
    connection.push({
      type: "manage-response",
      "request-id": request["request-id"],
      outcome: { result: "ok" },
    });
    await expect(first).resolves.toEqual({ result: "ok" });
    expect(vi.getTimerCount()).toBe(baseline + 1);
    await vi.advanceTimersByTimeAsync(MANAGE_REQUEST_TIMEOUT_MS);
    await expect(secondOutcome).resolves.toEqual({
      result: "error",
      code: "timeout",
    });
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
