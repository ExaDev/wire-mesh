// Live-runtime verification of a relay pairing that has gone quiet: two real WebSocket clients pair, then say nothing for long enough that the Durable Object holding the pairing is evicted, then relay in both directions. This is the case live-check.mjs cannot make, because it relays immediately and so never leaves the hub idle long enough to be evicted at all.
//
// Usage: `node scripts/idle-relay-live-check.mjs` against a local `wrangler dev` on :8787, or `node scripts/idle-relay-live-check.mjs wss://mesh.exadev.io/` against a real deployment. `--idle=<seconds>` overrides the default quiet period. Exits non-zero naming the failing step.
//
// What a local run proves and does not prove: workerd under `wrangler dev` does not evict a Durable Object on the same schedule production does, and may not evict it at all, so passing locally only shows the pairing still works after a long quiet period. It does not show it survives an eviction. Only a run against a real deployment does that, and only when the idle period comfortably exceeds production's own eviction threshold, which is why the default is well past it.

import { encode, decode, cdeEncodeOptions, cdeDecodeOptions } from "cbor2";

const args = process.argv.slice(2);
const HUB_URL =
  args.find((arg) => !arg.startsWith("--")) ?? "ws://localhost:8787/";
const idleArg = args.find((arg) => arg.startsWith("--idle="));
const MS_PER_SECOND = 1000;
const DEFAULT_IDLE_SECONDS = 30;
const IDLE_MS =
  (idleArg === undefined
    ? DEFAULT_IDLE_SECONDS
    : Number.parseInt(idleArg.slice("--idle=".length), 10)) * MS_PER_SECOND;

const SHA256_BYTE_LENGTH = 32;
const CONNECT_TIMEOUT_MS = 5000;
const FRAME_TIMEOUT_MS = 10000;
const GOSSIP_SETTLE_MS = 300;
const POLL_INTERVAL_MS = 20;

const deviceA = new Uint8Array(SHA256_BYTE_LENGTH).fill(0x11);
const deviceB = new Uint8Array(SHA256_BYTE_LENGTH).fill(0x22);
const requestPayload = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
const responsePayload = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]);

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
      setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
  });
}

function collectFrames(ws, queue) {
  ws.addEventListener("message", (event) => {
    queue.push(decode(new Uint8Array(event.data), cdeDecodeOptions));
  });
}

function watchForClose(ws, name, state) {
  ws.addEventListener("close", () => {
    state.closed = name;
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
const sockets = { closed: null };
collectFrames(a, queueA);
collectFrames(b, queueB);
watchForClose(a, "client A", sockets);
watchForClose(b, "client B", sockets);

sendFrame(a, gossipFor(deviceA));
sendFrame(b, gossipFor(deviceB));
await new Promise((resolve) => setTimeout(resolve, GOSSIP_SETTLE_MS));

sendFrame(a, { type: "relay-connect", "target-device": deviceB });
const inbound = await waitFor(queueB, "relay-inbound").catch((error) =>
  fail("relay-inbound", error.message),
);
if (!bytesEqual(new Uint8Array(inbound["source-device"]), deviceA)) {
  fail("relay-inbound", `unexpected frame: ${JSON.stringify(inbound)}`);
}

// A's request goes out immediately, as a real client's would, and then nobody says anything until B answers. This is the shape that failed in production: the request arrives, the pairing then sits unused while whoever is on B's end decides, and the response comes back to a hub that has been evicted in the meantime.
sendFrame(a, {
  type: "relay-data",
  payload: requestPayload,
  "to-device": deviceB,
});
const request = await waitFor(queueB, "relay-data").catch((error) =>
  fail("a->b request", error.message),
);
if (!bytesEqual(new Uint8Array(request.payload), requestPayload)) {
  fail("a->b request", `unexpected payload: ${JSON.stringify(request)}`);
}

console.log(`paired and relayed; going quiet for ${IDLE_MS / MS_PER_SECOND}s`);
await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
if (sockets.closed !== null) {
  fail("idle", `${sockets.closed} was disconnected during the quiet period`);
}

sendFrame(b, {
  type: "relay-data",
  payload: responsePayload,
  "to-device": deviceA,
});
const response = await waitFor(queueA, "relay-data").catch((error) =>
  fail("b->a response after idle", error.message),
);
if (
  !bytesEqual(new Uint8Array(response.payload), responsePayload) ||
  !bytesEqual(new Uint8Array(response["from-device"]), deviceB)
) {
  fail(
    "b->a response after idle",
    `unexpected frame: ${JSON.stringify(response)}`,
  );
}

// The other direction on the same aged pairing, so a pass is not just B's own half of it being restored.
sendFrame(a, {
  type: "relay-data",
  payload: requestPayload,
  "to-device": deviceB,
});
const followUp = await waitFor(queueB, "relay-data").catch((error) =>
  fail("a->b after idle", error.message),
);
if (!bytesEqual(new Uint8Array(followUp.payload), requestPayload)) {
  fail("a->b after idle", `unexpected frame: ${JSON.stringify(followUp)}`);
}

a.close();
b.close();
console.log(
  `PASS: a relay pairing idle for ${IDLE_MS / MS_PER_SECOND}s still relayed in both directions`,
);
process.exit(0);
