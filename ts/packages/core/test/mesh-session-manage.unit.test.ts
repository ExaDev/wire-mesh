import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityScope,
  CapabilityToken,
  ManageCommand,
  ManageRequestFrame,
  ManageResponseFrame,
} from "../src/generated/protocol.js";
import {
  createMeshSession,
  type IncomingManageRequest,
  type ManageOutcome,
} from "../src/domain/mesh-session.js";
import {
  EVENTS_THROUGH_FAILURE,
  EVENTS_THROUGH_REMOTE_HANDSHAKE,
  MANAGE_REQUEST_TIMEOUT_MS,
  OVERRIDE_TOKEN_BYTE,
  OWN_VERSION,
  TEST_INCOMING_REQUEST_ID,
  TEST_TOKEN_SIGNATURE_BYTE,
  TIMEOUT_MARKER,
  fakeTransport,
  nthEvent,
  testClock,
  testIdentity,
  withinShortWait,
  yielded,
} from "./mesh-session-fixtures.js";

describe("capability tokens and manage-request plumbing", () => {
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

  it("attaches the current token to every manage-request it sends", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    session.setToken(testToken);
    const pending = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
    expect(sentRequest.type).toBe("manage-request");
    expect(sentRequest.command).toEqual(testCommand);
    expect(sentRequest.scope).toEqual(testScope);
    expect(sentRequest.token).toEqual(testToken);
    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("does not attach a token to a manage-request when none has been set", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
    expect(sentRequest.token).toBeUndefined();
    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("attaches a per-call token override even when no session-global token has been set", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(
      testCommand,
      testScope,
      undefined,
      testToken,
    );
    await Promise.resolve();
    const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
    expect(sentRequest.token).toEqual(testToken);
    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("a per-call token override takes precedence over the session-global token for that one request only", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    session.setToken(testToken);
    const overrideToken: CapabilityToken = [
      new Uint8Array([OVERRIDE_TOKEN_BYTE]),
      {},
      new Uint8Array([OVERRIDE_TOKEN_BYTE]),
      new Uint8Array([OVERRIDE_TOKEN_BYTE]),
    ];

    const overridden = session.sendManageRequest(
      testCommand,
      testScope,
      undefined,
      overrideToken,
    );
    await Promise.resolve();
    expect((connection.sent.at(-1) as ManageRequestFrame).token).toEqual(
      overrideToken,
    );

    // The very next request, with no override of its own, must fall back to setToken's session-global value -- the override applies to the one call it was passed to, not for the rest of the session.
    const usingSessionDefault = session.sendManageRequest(
      testCommand,
      testScope,
    );
    await Promise.resolve();
    expect((connection.sent.at(-1) as ManageRequestFrame).token).toEqual(
      testToken,
    );

    await session.close();
    await expect(overridden).rejects.toThrow();
    await expect(usingSessionDefault).rejects.toThrow();
  });

  it("assigns sequentially increasing request-ids to successive sendManageRequest calls", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const first = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const firstId = (connection.sent.at(-1) as ManageRequestFrame)[
      "request-id"
    ];
    const second = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const secondId = (connection.sent.at(-1) as ManageRequestFrame)[
      "request-id"
    ];
    expect(secondId).toBe(firstId + 1);
    await session.close();
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
  });

  it("refuses sendManageRequest while not connected", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await expect(
      session.sendManageRequest(testCommand, testScope),
    ).rejects.toThrow("not connected");
  });

  it("refuses sendManageRequest once the connection has failed and closed, not just before the first connect", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    connection.fail(new Error("dropped"));
    await nthEvent(session, EVENTS_THROUGH_FAILURE);
    await expect(
      session.sendManageRequest(testCommand, testScope),
    ).rejects.toThrow("not connected");
  });

  it("never times out a request when no timeoutMs is given", async () => {
    vi.useFakeTimers();
    try {
      const { transport, connection } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, testClock);
      await session.connect("ws://node", ["core/management"]);
      const pending = session.sendManageRequest(testCommand, testScope);
      await vi.advanceTimersByTimeAsync(1);
      const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
      connection.push({
        type: "manage-response",
        "request-id": sentRequest["request-id"],
        outcome: { result: "ok" },
      } satisfies ManageResponseFrame);
      await expect(pending).resolves.toEqual({ result: "ok" });
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves sendManageRequest only with the outcome of the matching manage-response", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
    const requestId = sentRequest["request-id"];

    // A response for a different request-id must not resolve this pending request.
    connection.push({
      type: "manage-response",
      "request-id": requestId + 1,
      outcome: { result: "error", code: "wrong-request" },
    } satisfies ManageResponseFrame);
    connection.push({
      type: "manage-response",
      "request-id": requestId,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);

    const outcome: ManageOutcome = await pending;
    expect(outcome).toEqual({ result: "ok" });
    await session.close();
  });

  it("rejects a pending sendManageRequest when the session is closed before a response arrives", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    await session.close();
    await expect(pending).rejects.toThrow(
      "connection closed before a response arrived",
    );
  });

  it("rejects a pending sendManageRequest when the connection disconnects before a response arrives", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    connection.fail(new Error("dropped"));
    await expect(pending).rejects.toThrow(
      "disconnected before a response arrived",
    );
  });

  it("resolves with a timeout outcome, not a hang, when no response arrives within timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, testClock);
      await session.connect("ws://node", ["core/management"]);
      const pending = session.sendManageRequest(
        testCommand,
        testScope,
        undefined,
        undefined,
        MANAGE_REQUEST_TIMEOUT_MS,
      );
      await vi.advanceTimersByTimeAsync(MANAGE_REQUEST_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({
        result: "error",
        code: "timeout",
      });
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a request whose response arrives before timeoutMs elapses", async () => {
    vi.useFakeTimers();
    try {
      const { transport, connection } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, testClock);
      await session.connect("ws://node", ["core/management"]);
      const pending = session.sendManageRequest(
        testCommand,
        testScope,
        undefined,
        undefined,
        MANAGE_REQUEST_TIMEOUT_MS,
      );
      await vi.advanceTimersByTimeAsync(0);
      const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
      connection.push({
        type: "manage-response",
        "request-id": sentRequest["request-id"],
        outcome: { result: "ok" },
      } satisfies ManageResponseFrame);
      await expect(pending).resolves.toEqual({ result: "ok" });
      await vi.advanceTimersByTimeAsync(MANAGE_REQUEST_TIMEOUT_MS);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces an incoming manage-request on incomingManageRequests, and sends the response frame from respond()", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/management"]);
    await eventsDone;

    const incomingDone = (async (): Promise<
      IteratorResult<IncomingManageRequest>
    > => {
      const iterator = session.incomingManageRequests[Symbol.asyncIterator]();
      return iterator.next();
    })();

    connection.push({
      type: "manage-request",
      "request-id": TEST_INCOMING_REQUEST_ID,
      command: testCommand,
      scope: testScope,
      token: testToken,
    } satisfies ManageRequestFrame);

    const incomingResult = await incomingDone;
    expect(incomingResult.done).toBe(false);
    const incoming = yielded(incomingResult);
    expect(incoming.requestId).toBe(TEST_INCOMING_REQUEST_ID);
    expect(incoming.command).toEqual(testCommand);
    expect(incoming.scope).toEqual(testScope);
    expect(incoming.token).toEqual(testToken);

    // Consume the "received manage-request" event that is already backlogged.
    const eventsIterator = session.events[Symbol.asyncIterator]();
    await eventsIterator.next();

    await incoming.respond({ result: "ok" });
    const sentResponse = connection.sent.at(-1) as ManageResponseFrame;
    expect(sentResponse).toEqual({
      type: "manage-response",
      "request-id": TEST_INCOMING_REQUEST_ID,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    // Must already be available -- not merely eventually rescued by session.close()'s own trailing emit(), which would otherwise mask a missing emit() call inside respond().
    const responseResult = await withinShortWait(eventsIterator.next());
    expect(responseResult).not.toBe(TIMEOUT_MARKER);
    const responseEvent = yielded(
      responseResult as IteratorResult<{
        frameLog: { direction: string; frame: { type: string } }[];
      }>,
    );
    expect(responseEvent.frameLog.at(-1)).toEqual({
      direction: "sent",
      frame: sentResponse,
    });
    await session.close();
  });

  it("delivers a manage-request queued before anyone was iterating incomingManageRequests, from the backlog", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/management"]);
    await eventsDone;

    const nextEventDone = nthEvent(session, 1);
    connection.push({
      type: "manage-request",
      "request-id": TEST_INCOMING_REQUEST_ID,
      command: testCommand,
      scope: testScope,
    } satisfies ManageRequestFrame);
    await nextEventDone;

    const iterator = session.incomingManageRequests[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect(yielded(result).requestId).toBe(TEST_INCOMING_REQUEST_ID);
    await session.close();
  });

  const versionGetCommand: ManageCommand = {
    verb: "core:version",
    params: { verb: "version.get" },
  };

  it("answers a version.get manage-request directly with this node's own live version, bypassing incomingManageRequests entirely", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/version"]);
    await eventsDone;

    const incomingIterator =
      session.incomingManageRequests[Symbol.asyncIterator]();
    const eventsIterator = session.events[Symbol.asyncIterator]();

    connection.push({
      type: "manage-request",
      "request-id": TEST_INCOMING_REQUEST_ID,
      command: versionGetCommand,
      scope: { kind: "node" },
    } satisfies ManageRequestFrame);

    // The auto-response's own emit() -- must already be available, not merely eventually rescued by session.close()'s own trailing emit(), which would otherwise mask a missing emit() call inside the auto-responder.
    const responseResult = await withinShortWait(eventsIterator.next());
    expect(responseResult).not.toBe(TIMEOUT_MARKER);

    const sentResponse = connection.sent.at(-1) as ManageResponseFrame;
    expect(sentResponse).toEqual({
      type: "manage-response",
      "request-id": TEST_INCOMING_REQUEST_ID,
      outcome: { result: "ok", version: OWN_VERSION },
    } satisfies ManageResponseFrame);

    const notSurfaced = await withinShortWait(incomingIterator.next());
    expect(notSurfaced).toBe(TIMEOUT_MARKER);

    await session.close();
  });

  it("answers version.get regardless of the enclosing manage-request-frame's own scope and token, since it is deliberately ungated", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/version"]);
    await eventsDone;

    const eventsIterator = session.events[Symbol.asyncIterator]();
    connection.push({
      type: "manage-request",
      "request-id": TEST_INCOMING_REQUEST_ID,
      command: versionGetCommand,
      scope: { kind: "folder", path: "/anything" },
      token: testToken,
    } satisfies ManageRequestFrame);
    await withinShortWait(eventsIterator.next());

    const sentResponse = connection.sent.at(-1) as ManageResponseFrame;
    expect(sentResponse.outcome).toEqual({
      result: "ok",
      version: OWN_VERSION,
    });
    await session.close();
  });
});
