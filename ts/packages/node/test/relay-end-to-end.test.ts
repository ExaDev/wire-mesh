// Real, in-suite equivalent of cloudflare-hub/scripts/live-check.mjs: two genuine wire-mesh-node clients gossiping, relay-connecting, and exchanging relay-data through a real createRelayHub() wired over a real createNodeWebSocketTransport() listener -- the same health-check wiring server.ts itself uses, so this test also proves the plain-HTTP health path works on the same listener a WebSocket client connects to.

import { describe, expect, it } from "vitest";
import { createRelayHub } from "@exadev/wire-mesh-core/domain/relay-hub";
import type {
  DeviceId,
  Frame,
} from "@exadev/wire-mesh-core/generated/protocol";
import { createNodeWebSocketTransport } from "../src/adapters/node-websocket-transport.js";
import { healthResponse } from "../src/server.js";
import { bytesFromHex, deviceIdFromFillHex } from "./hex.js";

const HTTP_OK = 200;
const FRAME_WAIT_TIMEOUT_MS = 2000;
const FRAME_POLL_INTERVAL_MS = 10;
const GOSSIP_SETTLE_MS = 100;

function gossipFor(device: DeviceId): Frame {
  return {
    type: "gossip",
    peers: [
      {
        device,
        addresses: ["203.0.113.5:4433"],
        "snapshot-seconds": 1861833600,
      },
    ],
  };
}

interface FrameQueue {
  push: (frame: Frame) => void;
  /** Polls for the next frame of the given type, removing it from the queue once found -- mirroring live-check.mjs's own waitFor helper, but as queue methods rather than raw array mutation so callers never hold a mutable reference to the backing array. */
  waitFor: (expectedType: Frame["type"]) => Promise<Frame>;
}

function createFrameQueue(): FrameQueue {
  const frames: Frame[] = [];
  return {
    push(frame) {
      frames.push(frame);
    },
    async waitFor(expectedType) {
      const started = Date.now();
      for (;;) {
        const index = frames.findIndex((frame) => frame.type === expectedType);
        if (index !== -1) {
          const [frame] = frames.splice(index, 1);
          if (frame) {
            return frame;
          }
        }
        if (Date.now() - started > FRAME_WAIT_TIMEOUT_MS) {
          throw new Error(
            `timed out waiting for ${expectedType}; queue holds ${JSON.stringify(frames.map((frame) => frame.type))}`,
          );
        }
        await new Promise((resolve) => {
          setTimeout(resolve, FRAME_POLL_INTERVAL_MS);
        });
      }
    },
  };
}

describe("wire-mesh-node relay, end to end", () => {
  it("relays gossip -> relay-connect -> relay-inbound -> bidirectional relay-data between two real WebSocket clients", async () => {
    const hub = createRelayHub();
    const serverTransport = createNodeWebSocketTransport({
      onHttpRequest: (_request, response) => {
        response.writeHead(HTTP_OK, { "content-type": "application/json" });
        response.end(JSON.stringify(healthResponse()));
      },
    });
    const listener = await serverTransport.listen(
      "127.0.0.1:0",
      (connection) => {
        void hub.handleConnection(connection);
      },
    );

    const deviceA = deviceIdFromFillHex("11");
    const deviceB = deviceIdFromFillHex("22");
    const relayPayload = bytesFromHex("deadbeef");

    const clientTransport = createNodeWebSocketTransport();
    const a = await clientTransport.connect(listener.address);
    const b = await clientTransport.connect(listener.address);
    const queueA = createFrameQueue();
    const queueB = createFrameQueue();
    void (async () => {
      for await (const frame of a.receive()) {
        queueA.push(frame);
      }
    })();
    void (async () => {
      for await (const frame of b.receive()) {
        queueB.push(frame);
      }
    })();

    await a.send(gossipFor(deviceA));
    await b.send(gossipFor(deviceB));
    // Gossip must be registered by the hub before relay-connect is sent: over a real socket, a.send() resolving only means the bytes left this process, not that the hub's own receive loop on the other end has processed them yet.
    await new Promise((resolve) => {
      setTimeout(resolve, GOSSIP_SETTLE_MS);
    });
    await a.send({ type: "relay-connect", "target-device": deviceB });

    const inbound = await queueB.waitFor("relay-inbound");
    expect(inbound).toEqual({
      type: "relay-inbound",
      "source-device": deviceA,
    });

    await a.send({ type: "relay-data", payload: relayPayload });
    await b.send({ type: "relay-data", payload: relayPayload });

    const toB = await queueB.waitFor("relay-data");
    const toA = await queueA.waitFor("relay-data");
    expect(toB).toEqual({ type: "relay-data", payload: relayPayload });
    expect(toA).toEqual({ type: "relay-data", payload: relayPayload });

    await a.close();
    await b.close();
    await listener.close();
  });

  it("answers a plain (non-Upgrade) HTTP request on the same listener with the health response", async () => {
    const hub = createRelayHub();
    const serverTransport = createNodeWebSocketTransport({
      onHttpRequest: (_request, response) => {
        response.writeHead(HTTP_OK, { "content-type": "application/json" });
        response.end(JSON.stringify(healthResponse()));
      },
    });
    const listener = await serverTransport.listen(
      "127.0.0.1:0",
      (connection) => {
        void hub.handleConnection(connection);
      },
    );

    const response = await fetch(`http://${listener.address}/`);
    expect(response.status).toBe(HTTP_OK);
    expect(await response.json()).toEqual(healthResponse());

    await listener.close();
  });
});
