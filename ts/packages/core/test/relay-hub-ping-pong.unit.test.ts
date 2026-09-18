// wire-mesh#181: relay-hub replies to a bare ping with a bare pong -- the piece that lets a client isolate its own sender-to-hub leg of a relayed round trip, entirely below the manage-command/capability layer this hub otherwise stays out of.

import { describe, expect, it } from "vitest";
import { createRelayHub } from "../src/domain/relay-hub.js";
import { FakeConnection, tick } from "./relay-hub-test-helpers.js";

describe("relay-hub ping/pong", () => {
  it("replies to a ping with a bare pong, with no relay pairing or device registration needed", async () => {
    const hub = createRelayHub();
    const client = new FakeConnection();
    const handled = hub.handleConnection(client.connection);

    client.push({ type: "ping" });
    await tick();

    expect(client.sent).toEqual([{ type: "pong" }]);

    await client.end();
    await handled;
  });

  it("answers every ping on the same connection with its own pong, in order", async () => {
    const hub = createRelayHub();
    const client = new FakeConnection();
    const handled = hub.handleConnection(client.connection);

    client.push({ type: "ping" });
    client.push({ type: "ping" });
    await tick();

    expect(client.sent).toEqual([{ type: "pong" }, { type: "pong" }]);

    await client.end();
    await handled;
  });

  it("swallows a failed pong reply rather than throwing out of handleConnection", async () => {
    const hub = createRelayHub();
    const client = new FakeConnection();
    client.sendRejection = new Error("connection died mid-reply");
    const handled = hub.handleConnection(client.connection);

    client.push({ type: "ping" });
    await tick();

    // The reply attempt failed silently (the connection is treated as already dead); handleConnection itself must not reject.
    await client.end();
    await expect(handled).resolves.toBeUndefined();
  });

  it("also replies to ping via the shared registerConnection/onFrame integration path, not only handleConnection's own loop", async () => {
    const hub = createRelayHub();
    const client = new FakeConnection();
    hub.registerConnection(client.connection);

    await hub.onFrame(client.connection, { type: "ping" });

    expect(client.sent).toEqual([{ type: "pong" }]);
    hub.onDisconnect(client.connection);
  });
});
