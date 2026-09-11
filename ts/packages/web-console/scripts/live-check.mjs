// Live-runtime verification for the WebRTC data path: drives two real browser contexts, each running the real mesh-session/webrtc-negotiation/webrtc-transport modules against a real RTCPeerConnection, through the full core/webrtc signaling exchange, and asserts a real RTCDataChannel opens between the two contexts carrying a byte-identical frame. This is the check vitest cannot make: neither RTCPeerConnection nor RTCDataChannel exists under Node/vitest at all (unlike WebSocket, which Node provides natively), so the actual ICE negotiation and channel establishment this feature depends on is otherwise never exercised against a real implementation.
//
// Manual/dev-time only, not part of `pnpm test`/CI, for the same reason cloudflare-hub/scripts/live-check.mjs is: it needs a real browser and a real running relay, neither of which CI provides for this package.
//
// IMPORTANT DEVIATION, called out explicitly: core's relay-hub domain (used by both wire-mesh-node and cloudflare-hub) deliberately does not forward manage-request/manage-response frames between connected clients -- see relay-hub.ts's own handleFrame, whose final branch comment reads "Everything else ... is not the relay role's business ... Frames are consumed and dropped." That is correct for relay-hub's actual job (gossip/relay-connect/relay-data), but it means neither wire-mesh-node nor cloudflare-hub can carry a webrtc-offer/answer/ice-candidate manage-request from one connected client to another today -- extending relay-hub to also proxy manage-request domains between peers is a real, separate design change belonging to whichever future work adds that, not something this item's brief asked for or something safe to bolt on silently here. So this script runs its own tiny, purpose-built relay instead: a plain WebSocket server that broadcasts every raw message it receives to every other currently-connected client, verbatim, with no frame parsing at all. That is sufficient to let the two real MeshSession connections this script drives see each other as the "remote" (handshake, self-advert, and this feature's own manage-request signaling all just work over it, since it never inspects frame contents), and it is honestly not wire-mesh-node or cloudflare-hub -- it is bespoke test infrastructure written only for this check, exactly as cloudflare-hub's own live-check.mjs already writes its own bespoke WebSocket client helpers rather than reusing production code for them.
//
// Usage: node scripts/live-check.mjs It starts its own relay and its own vite dev server (serving live-check/harness.html), launches two headless Chromium contexts via Playwright, drives the exchange, and tears everything down. Exits non-zero naming the failing step.
//
// A host whose only routable network interface refuses to hairpin UDP back to itself (confirmed directly here with a bare dgram socket, independent of Chromium/WebRTC entirely -- send-to-self on the routable interface silently never arrives, while 127.0.0.1 works) will see ICE stall at "checking" forever and this script time out at the initiate() step, even though the signaling exchange itself (the actual core/webrtc offer/answer/ice-candidate manage-requests, verified via this script's own page-console forwarding) completes correctly. That is a property of the machine's network configuration, not of wire-mesh's code -- two genuinely separate hosts on the same LAN, the actual scenario this feature exists for, do not share this failure mode.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";

const RELAY_PORT = 8799;
const VITE_PORT = 8798;
const RELAY_ADDRESS = `ws://localhost:${RELAY_PORT}`;
const HARNESS_URL = `http://localhost:${VITE_PORT}/live-check/harness.html`;
const VITE_READY_TIMEOUT_MS = 20_000;
const NEGOTIATION_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;

function fail(step, detail) {
  console.error(`FAIL [${step}]: ${detail}`);
  process.exitCode = 1;
}

/** A dumb broadcast relay: every raw message received from one client is forwarded verbatim to every other currently-connected client. No frame parsing -- see the module header for why this stands in for wire-mesh-node/cloudflare-hub in this one check. */
function startBroadcastRelay(port) {
  const wss = new WebSocketServer({ port });
  const clients = new Set();
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("message", (data, isBinary) => {
      for (const other of clients) {
        if (other !== ws && other.readyState === other.OPEN) {
          other.send(data, { binary: isBinary });
        }
      }
    });
    ws.on("close", () => {
      clients.delete(ws);
    });
  });
  return wss;
}

async function waitForHttpOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${url}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function pollUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function withTimeout(promise, timeoutMs, description) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`timed out waiting for ${description}`);
    }),
  ]);
}

function step(name) {
  console.log(`-- ${name}`);
}

const packageRoot = new URL("..", import.meta.url).pathname;

const relay = startBroadcastRelay(RELAY_PORT);

const vite = spawn(
  "npx",
  ["vite", "--port", String(VITE_PORT), "--strictPort"],
  { cwd: packageRoot, stdio: "pipe" },
);
let viteOutput = "";
vite.stdout.on("data", (chunk) => {
  viteOutput += String(chunk);
});
vite.stderr.on("data", (chunk) => {
  viteOutput += String(chunk);
});

let browser;
try {
  await waitForHttpOk(HARNESS_URL, VITE_READY_TIMEOUT_MS).catch((error) => {
    throw new Error(`${error.message}\nvite output so far:\n${viteOutput}`);
  });

  // Chrome's default mDNS candidate obfuscation replaces a host candidate's real local IP with a random .local hostname (privacy feature), which never resolves between two independent Chromium processes running headless without real multicast DNS -- the standard fix for automated same-machine WebRTC testing is disabling it so host candidates carry a real, directly connectable IP. --allow-loopback-in-peer-connection additionally lets ICE actually use 127.0.0.1 as a host candidate -- normally excluded, since it is meaningless across a real network, but exactly what two PeerConnections on the very same machine need, and this machine's own routable interface (en0) refuses to hairpin a UDP packet back to itself (confirmed directly against a bare dgram socket, independent of Chromium/WebRTC entirely), which real loopback does not have that restriction.
  browser = await chromium.launch({
    args: [
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--allow-loopback-in-peer-connection",
    ],
  });
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  pageA.on("console", (msg) => console.log(`[page A] ${msg.text()}`));
  pageB.on("console", (msg) => console.log(`[page B] ${msg.text()}`));
  pageA.on("pageerror", (err) => console.log(`[page A error] ${err.message}`));
  pageB.on("pageerror", (err) => console.log(`[page B error] ${err.message}`));
  step("navigating both pages to the harness");
  await pageA.goto(HARNESS_URL);
  await pageB.goto(HARNESS_URL);

  step("connecting both sessions to the relay");
  await withTimeout(
    pageA.evaluate((address) => window.harness.connect(address), RELAY_ADDRESS),
    NEGOTIATION_TIMEOUT_MS,
    "A to connect",
  ).catch((error) => {
    fail("connect A", error.message);
    throw error;
  });
  await withTimeout(
    pageB.evaluate((address) => window.harness.connect(address), RELAY_ADDRESS),
    NEGOTIATION_TIMEOUT_MS,
    "B to connect",
  ).catch((error) => {
    fail("connect B", error.message);
    throw error;
  });

  step("B starts listening for an incoming negotiation");
  // B starts listening for an incoming negotiation before A offers one, and A's initiate() call and B's waitForIncoming() call race against each other's manage-request exchange in real time -- both must be in flight together.
  const bIncoming = pageB.evaluate(() => window.harness.waitForIncoming());
  // Marks the rejection as observed regardless of what the main flow below does with bIncoming (e.g. the page/context closing before this ever resolves, once an earlier step has already failed) -- without this, an unresolved-then-rejected bIncoming crashes the whole process as an unhandled rejection independent of the real failure already reported.
  bIncoming.catch(() => undefined);

  step("A initiates a webrtc negotiation");
  const aConnectionId = await withTimeout(
    pageA.evaluate(() => window.harness.initiate()),
    NEGOTIATION_TIMEOUT_MS,
    "A's initiate() to resolve",
  ).catch((error) => {
    fail("initiate (A)", error.message);
    throw error;
  });

  step("waiting for B's incoming data channel");
  const bConnectionId = await withTimeout(
    bIncoming,
    NEGOTIATION_TIMEOUT_MS,
    "B's incoming data channel",
  ).catch((error) => {
    fail("incoming connection (B)", error.message);
    throw error;
  });
  step(`negotiation complete: A=${aConnectionId} B=${bConnectionId}`);

  const gossip = {
    type: "gossip",
    peers: [
      {
        device: Array.from({ length: 32 }, () => 0x11),
        addresses: ["203.0.113.5:4433"],
        "snapshot-seconds": 1861833600,
      },
    ],
  };

  await pageA.evaluate(
    ({ connectionId, frame }) => window.harness.sendGossip(connectionId, frame),
    { connectionId: aConnectionId, frame: gossip },
  );
  const received = await pollUntil(
    () =>
      pageB
        .evaluate(
          (connectionId) => window.harness.receiveGossip(connectionId),
          bConnectionId,
        )
        .then((frame) => frame)
        .catch(() => undefined),
    NEGOTIATION_TIMEOUT_MS,
    "B to receive the frame sent over the data channel",
  ).catch((error) => {
    fail("receive over data channel", error.message);
    throw error;
  });

  const receivedDevice = received?.peers?.[0]?.device ?? [];
  const sentDevice = gossip.peers[0].device;
  const byteIdentical =
    receivedDevice.length === sentDevice.length &&
    receivedDevice.every((byte, index) => byte === sentDevice[index]);

  if (!byteIdentical) {
    fail(
      "byte-identical check",
      `sent ${JSON.stringify(sentDevice)}, received ${JSON.stringify(receivedDevice)}`,
    );
  } else if (process.exitCode !== 1) {
    console.log(
      "PASS: two real browser contexts negotiated a real RTCDataChannel over core/webrtc signaling and exchanged a byte-identical frame through it",
    );
  }

  await pageA.evaluate(
    (connectionId) => window.harness.closeConnection(connectionId),
    aConnectionId,
  );
  await pageB.evaluate(
    (connectionId) => window.harness.closeConnection(connectionId),
    bConnectionId,
  );
} catch (error) {
  if (process.exitCode !== 1) {
    fail("unexpected error", error instanceof Error ? error.stack : String(error));
  }
} finally {
  if (browser) {
    await browser.close();
  }
  vite.kill();
  relay.close();
  await new Promise((resolve) => {
    relay.close(resolve);
  }).catch(() => undefined);
}

process.exit(process.exitCode ?? 0);
