import { describe, expect, it } from "vitest";
import type {
  CapabilityToken,
  ManageRequestFrame,
} from "../src/generated/protocol.js";
import { acceptDirectManageRequest } from "../src/domain/direct-manage-request.js";
import { FakeConnection } from "./mesh-session-fixtures.js";

const TEST_TOKEN_SIGNATURE_BYTE = 3;
const TEST_REQUEST_ID = 4;
const RESPOND_TEST_REQUEST_ID = 9;

const testCommand: ManageRequestFrame["command"] = {
  verb: "exec:proc",
  params: { verb: "exec.list" },
};
const testScope: ManageRequestFrame["scope"] = { kind: "folder" };
const testToken: CapabilityToken = [
  new Uint8Array([1]),
  {},
  new Uint8Array([2]),
  new Uint8Array([TEST_TOKEN_SIGNATURE_BYTE]),
];

function manageRequestFrame(
  overrides: Partial<ManageRequestFrame> = {},
): ManageRequestFrame {
  return {
    type: "manage-request",
    "request-id": TEST_REQUEST_ID,
    command: testCommand,
    scope: testScope,
    ...overrides,
  };
}

describe("acceptDirectManageRequest", () => {
  it("resolves to null when the connection ends before any frame arrives", async () => {
    const fake = new FakeConnection();
    const pending = acceptDirectManageRequest(fake.connection);
    fake.endStream();
    await expect(pending).resolves.toBeNull();
  });

  it("resolves to null when the first frame is not a manage-request", async () => {
    const fake = new FakeConnection();
    const pending = acceptDirectManageRequest(fake.connection);
    fake.push({ type: "ping" });
    await expect(pending).resolves.toBeNull();
  });

  it("surfaces a manage-request as the first frame, with no handshake or gossip sent or expected", async () => {
    const fake = new FakeConnection();
    const pending = acceptDirectManageRequest(fake.connection);
    fake.push(manageRequestFrame());
    const incoming = await pending;
    expect(incoming?.requestId).toBe(TEST_REQUEST_ID);
    expect(incoming?.command).toEqual(testCommand);
    expect(incoming?.scope).toEqual(testScope);
    expect(fake.sent).toEqual([]);
  });

  it("carries the request's token through when present", async () => {
    const fake = new FakeConnection();
    const pending = acceptDirectManageRequest(fake.connection);
    fake.push(manageRequestFrame({ token: testToken }));
    const incoming = await pending;
    expect(incoming?.token).toEqual(testToken);
  });

  it("omits token entirely when the request carried none, rather than a stray undefined key", async () => {
    const fake = new FakeConnection();
    const pending = acceptDirectManageRequest(fake.connection);
    fake.push(manageRequestFrame());
    const incoming = await pending;
    expect(incoming && "token" in incoming).toBe(false);
  });

  it("respond() sends the correlated manage-response and closes the connection", async () => {
    const fake = new FakeConnection();
    const pending = acceptDirectManageRequest(fake.connection);
    fake.push(manageRequestFrame({ "request-id": RESPOND_TEST_REQUEST_ID }));
    const incoming = await pending;
    await incoming?.respond({ result: "ok" });
    expect(fake.sent).toEqual([
      {
        type: "manage-response",
        "request-id": RESPOND_TEST_REQUEST_ID,
        outcome: { result: "ok" },
      },
    ]);
    expect(fake.isClosed).toBe(true);
  });
});
