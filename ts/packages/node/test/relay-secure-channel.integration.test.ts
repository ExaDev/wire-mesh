// Two real MeshSessions exchanging manage-requests through a real hub over real WebSockets, with the hub instrumented: what it forwards is ciphertext, the receiver learns who sent a request from the channel and not from the hub, and a hub that alters what it carries gets nothing through.

import { describe, expect, it } from "vitest";
import {
  messageFromFrame,
  tryDecodeFrame,
} from "wire-mesh-core/adapters/frame-codec";
import { createMeshSession } from "wire-mesh-core/domain/mesh-session";
import { createRelayHub } from "wire-mesh-core/domain/relay-hub";
import type {
  CapabilityScope,
  Frame,
  ManageCommand,
} from "wire-mesh-core/generated/protocol";
import type { Connection } from "wire-mesh-core/ports/transport";
import { createNodeWebSocketTransport } from "../src/adapters/node-websocket-transport.js";
import { createTestPeer, hubVerifier } from "./signed-peers.js";

const command: ManageCommand = {
  verb: "exec:proc",
  params: { verb: "exec.list" },
};
const scope: CapabilityScope = {
  kind: "folder",
  path: "a-recognisable-folder-path",
};
const REQUEST_TIMEOUT_MS = 4000;
const TAMPERED_REQUEST_TIMEOUT_MS = 600;
const LOW_BYTE_MASK = 0xff;
const GOSSIP_SETTLE_MS = 200;

/** A hub-side view of a connection that lets the test see every frame the hub receives on it and change them on the way in. */
function observed(
  connection: Readonly<Connection>,
  record: (frame: Frame) => void,
  tamper: (frame: Frame) => Frame,
): Connection {
  return {
    ...connection,
    receive: async function* () {
      for await (const frame of connection.receive()) {
        record(frame);
        yield tamper(frame);
      }
    },
  };
}

async function twoSessionsThroughAHub(tamper: (frame: Frame) => Frame) {
  const seen: Frame[] = [];
  const hub = createRelayHub({ identity: hubVerifier });
  const listener = await createNodeWebSocketTransport().listen(
    "127.0.0.1:0",
    (connection) => {
      void hub.handleConnection(
        observed(
          connection,
          (frame) => {
            seen.push(frame);
          },
          tamper,
        ),
      );
    },
  );
  const peerA = await createTestPeer();
  const peerB = await createTestPeer();
  const sessionA = createMeshSession(
    createNodeWebSocketTransport(),
    peerA.identity,
  );
  const sessionB = createMeshSession(
    createNodeWebSocketTransport(),
    peerB.identity,
  );
  await sessionA.connect(listener.address, ["core/management"]);
  await sessionB.connect(listener.address, ["core/management"]);
  // Each session gossips its advert as it connects; the hub can only route to a device it has heard of.
  await new Promise((resolve) => {
    setTimeout(resolve, GOSSIP_SETTLE_MS);
  });

  return { seen, peerA, peerB, sessionA, sessionB, listener };
}

describe("a request through a relay, end to end", () => {
  it("reaches the other session attributed to the device that sent it, and the hub sees only ciphertext", async () => {
    const { seen, peerA, peerB, sessionA, sessionB, listener } =
      await twoSessionsThroughAHub((frame) => frame);
    const received = (async () => {
      for await (const request of sessionB.incomingManageRequests) {
        await request.respond({ result: "ok" });

        return request;
      }

      return undefined;
    })();

    const outcome = await sessionA.sendManageRequest(
      command,
      scope,
      peerB.device,
      undefined,
      REQUEST_TIMEOUT_MS,
    );

    expect(outcome).toEqual({ result: "ok" });
    const request = await received;
    expect(request?.fromDevice).toEqual(peerA.device);
    const relayed = seen.flatMap((frame) =>
      frame.type === "relay-data" ? [frame] : [],
    );
    expect(relayed.length).toBeGreaterThan(0);
    for (const frame of relayed) {
      const inner = tryDecodeFrame(frame.payload);
      expect(["secure-hello", "secure-data"]).toContain(inner?.type);
      expect(new TextDecoder("latin1").decode(frame.payload)).not.toContain(
        "a-recognisable-folder-path",
      );
    }
    await sessionA.close();
    await sessionB.close();
    await listener.close();
  });

  it("gets nothing through a hub that alters the sealed data it carries", async () => {
    const { peerB, sessionA, sessionB, listener } =
      await twoSessionsThroughAHub((frame) => {
        if (frame.type !== "relay-data") return frame;
        const inner = tryDecodeFrame(frame.payload);
        if (inner?.type !== "secure-data") return frame;
        const ciphertext = Uint8Array.from(inner.ciphertext);
        ciphertext[0] = (ciphertext[0] ?? 0) ^ LOW_BYTE_MASK;

        return {
          ...frame,
          payload: messageFromFrame({ ...inner, ciphertext }),
        };
      });
    const delivered: unknown[] = [];
    void (async () => {
      for await (const request of sessionB.incomingManageRequests) {
        delivered.push(request);
      }
    })();

    const outcome = await sessionA.sendManageRequest(
      command,
      scope,
      peerB.device,
      undefined,
      TAMPERED_REQUEST_TIMEOUT_MS,
    );

    expect(outcome).toEqual({ result: "error", code: "timeout" });
    expect(delivered).toEqual([]);
    await sessionA.close();
    await sessionB.close();
    await listener.close();
  });
});
