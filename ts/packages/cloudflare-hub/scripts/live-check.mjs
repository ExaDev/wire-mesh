// Live-runtime verification: drives the hub end to end against a real `wrangler dev` workerd process -- two genuine WebSocket clients exchanging gossip, relay-connect, and relay-data through the Durable Object. This is the check `wrangler deploy --dry-run` (the CI gate) cannot make: bundling executes nothing, and the original plain-Worker entry passed dry-run while never relaying a frame on the real runtime.
//
// Usage: start the dev server in one terminal (`pnpm dev`, serving on :8787), then `node scripts/live-check.mjs`. Exits non-zero naming the failing step.

import { encode, decode, cdeEncodeOptions, cdeDecodeOptions } from "cbor2";

const HUB_URL = "ws://localhost:8787/";
const SHA256_BYTE_LENGTH = 32;
const CONNECT_TIMEOUT_MS = 5000;
const FRAME_TIMEOUT_MS = 3000;
const GOSSIP_SETTLE_MS = 300;

const deviceA = new Uint8Array(SHA256_BYTE_LENGTH).fill(0x11);
const deviceB = new Uint8Array(SHA256_BYTE_LENGTH).fill(0x22);
const relayPayload = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);

function fail(step, detail) {
  console.error(`FAIL [${step}]: ${detail}`);
  process.exit(1);
}

function gossipFor(device) {
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

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HUB_URL);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(
      () => reject(new Error(`${name}: connect/open timed out`)),
      CONNECT_TIMEOUT_MS,
    );
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${name}: connection error`));
    });
  });
}

function sendFrame(ws, frame) {
  ws.send(new Uint8Array(encode(frame, cdeEncodeOptions)));
}

function bytesEqual(a, b) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Polls a per-client frame queue for the next frame of the expected type (other types stay queued). */
function waitFor(queue, expectedType) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const index = queue.findIndex((frame) => frame.type === expectedType);
      if (index !== -1) {
        resolve(queue.splice(index, 1)[0]);
        return;
      }
      if (Date.now() - started > FRAME_TIMEOUT_MS) {
        reject(
          new Error(
            `timed out waiting for ${expectedType}; queue holds ${JSON.stringify(queue.map((f) => f.type))}`,
          ),
        );
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function collectFrames(ws, queue) {
  ws.addEventListener("message", (event) => {
    queue.push(decode(new Uint8Array(event.data), cdeDecodeOptions));
  });
}

const a = await connect("client A").catch((error) =>
  fail("connect A", error.message),
);
const b = await connect("client B").catch((error) =>
  fail("connect B", error.message),
);
const queueA = [];
const queueB = [];
collectFrames(a, queueA);
collectFrames(b, queueB);

sendFrame(a, gossipFor(deviceA));
sendFrame(b, gossipFor(deviceB));
await new Promise((resolve) => setTimeout(resolve, GOSSIP_SETTLE_MS));

sendFrame(a, { type: "relay-connect", "target-device": deviceB });
const inbound = await waitFor(queueB, "relay-inbound").catch((error) =>
  fail("relay-inbound", error.message),
);
if (
  inbound.type !== "relay-inbound" ||
  !bytesEqual(new Uint8Array(inbound["source-device"]), deviceA)
) {
  fail("relay-inbound", `unexpected frame: ${JSON.stringify(inbound)}`);
}

sendFrame(a, { type: "relay-data", payload: relayPayload });
sendFrame(b, { type: "relay-data", payload: relayPayload });
const toB = await waitFor(queueB, "relay-data").catch((error) =>
  fail("a->b relay-data", error.message),
);
const toA = await waitFor(queueA, "relay-data").catch((error) =>
  fail("b->a relay-data", error.message),
);
for (const [label, frame] of [
  ["a->b", toB],
  ["b->a", toA],
]) {
  if (
    frame.type !== "relay-data" ||
    !bytesEqual(new Uint8Array(frame.payload), relayPayload)
  ) {
    fail(`${label} relay-data`, `unexpected frame: ${JSON.stringify(frame)}`);
  }
}

a.close();
b.close();
console.log(
  "PASS: two real WebSocket clients relayed gossip -> relay-connect -> relay-inbound -> bidirectional relay-data through the Durable Object hub",
);
process.exit(0);
