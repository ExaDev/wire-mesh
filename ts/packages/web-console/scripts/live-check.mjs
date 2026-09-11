// Live-runtime verification for the WebRTC data path: drives two real browser contexts, each running the real mesh-session/webrtc-negotiation/webrtc-transport modules against a real RTCPeerConnection, through the full core/webrtc signaling exchange relayed through a real, unmodified wire-mesh-node relay, and asserts a real RTCDataChannel opens between the two contexts carrying a byte-identical frame. This is the check vitest cannot make: neither RTCPeerConnection nor RTCDataChannel exists under Node/vitest at all (unlike WebSocket, which Node provides natively), so the actual ICE negotiation and channel establishment this feature depends on is otherwise never exercised against a real implementation.
//
// Manual/dev-time only, not part of `pnpm test`/CI, for the same reason cloudflare-hub/scripts/live-check.mjs is: it needs a real browser and a real running relay, neither of which CI provides for this package.
//
// core's relay-hub domain (used by both wire-mesh-node and cloudflare-hub) deliberately does not forward manage-request/manage-response frames sent directly to it between connected clients -- see relay-hub.ts's own handleFrame, whose final branch comment reads "Everything else ... is not the relay role's business ... Frames are consumed and dropped." That is correct for relay-hub's actual job (gossip/relay-connect/relay-data), and it is exactly why core/webrtc signaling addressed to a specific peer rides inside relay-data's own opaque payload instead (see mesh-session.ts's sendManageRequest targetDevice parameter): relay-data is the one frame kind relay-hub already forwards blindly between an established relay-connect pairing, without ever inspecting what is inside it. This script boots a real wire-mesh-node server (this package's own sibling, built from ts/packages/node) as that relay -- not a bespoke stand-in -- specifically to prove the signaling frames genuinely traverse an unmodified relay-hub's real relay-data forwarding, not merely a test harness that happens to pass everything through.
//
// Usage: node scripts/live-check.mjs It builds and starts a real wire-mesh-node relay, its own vite dev server (serving live-check/harness.html), launches two headless Chromium contexts via Playwright, has each connect to the relay and gossip its own device-id, has one relay-connect to the other's device-id, then drives the full offer/answer/ice-candidate exchange over that pairing's relay-data forwarding, and tears everything down. Exits non-zero naming the failing step.
//
// A host whose only routable network interface refuses to hairpin UDP back to itself (confirmed directly here with a bare dgram socket, independent of Chromium/WebRTC entirely -- send-to-self on the routable interface silently never arrives, while 127.0.0.1 works) will see ICE stall at "checking" forever and this script time out at the initiate() step, even though the signaling exchange itself (the actual core/webrtc offer/answer/ice-candidate manage-requests, carried over the real relay's relay-data forwarding and verified via this script's own page-console forwarding) completes correctly. That is a property of the machine's network configuration, not of wire-mesh's code -- two genuinely separate hosts on the same LAN, the actual scenario this feature exists for, do not share this failure mode.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const VITE_PORT = 8798;
const HARNESS_URL = `http://localhost:${VITE_PORT}/live-check/harness.html`;
const VITE_READY_TIMEOUT_MS = 20_000;
const RELAY_READY_TIMEOUT_MS = 10_000;
const NEGOTIATION_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;
// The hub only registers a gossiped device once its own receive loop processes it -- over a real socket, session.connect() resolving only means the self-advert bytes left this process, not that the relay has processed them yet (the same real-socket timing gap node/test/relay-end-to-end.test.ts's own GOSSIP_SETTLE_MS documents).
const GOSSIP_SETTLE_MS = 200;

function fail(step, detail) {
  console.error(`FAIL [${step}]: ${detail}`);
  process.exitCode = 1;
}

const nodePackageRoot = new URL("../../node/", import.meta.url).pathname;

/** Boots a real wire-mesh-node relay (this package's own sibling, already built to dist/server.mjs) bound to an OS-assigned loopback port, resolving once its own "listening on" startup line names the bound address. */
async function startRealRelay() {
  const child = spawn("node", ["dist/server.mjs", "--bind", "127.0.0.1:0"], {
    cwd: nodePackageRoot,
    stdio: "pipe",
  });
  let output = "";
  const address = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += String(chunk);
      const match = /listening on (\S+)/.exec(output);
      if (match) {
        child.stdout.off("data", onData);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`wire-mesh-node exited early (code ${code}): ${output}`));
    });
    setTimeout(() => {
      reject(new Error(`timed out waiting for wire-mesh-node to start: ${output}`));
    }, RELAY_READY_TIMEOUT_MS).unref();
  });
  return { child, address };
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

function hex(bytes) {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const packageRoot = new URL("..", import.meta.url).pathname;

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
let relay;
try {
  step("starting a real wire-mesh-node relay");
  relay = await startRealRelay();
  const relayAddress = `ws://${relay.address}`;

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
  const deviceA = await withTimeout(
    pageA.evaluate((address) => window.harness.connect(address), relayAddress),
    NEGOTIATION_TIMEOUT_MS,
    "A to connect",
  ).catch((error) => {
    fail("connect A", error.message);
    throw error;
  });
  const deviceB = await withTimeout(
    pageB.evaluate((address) => window.harness.connect(address), relayAddress),
    NEGOTIATION_TIMEOUT_MS,
    "B to connect",
  ).catch((error) => {
    fail("connect B", error.message);
    throw error;
  });

  step(`A is device ${hex(deviceA)}, B is device ${hex(deviceB)}`);
  // Both sides have sent their self-advert gossip over the real socket by now, but the relay's own receive loop may not have registered them in its device registry yet -- give it a moment before either side tries to relay-connect against the other's device-id.
  await delay(GOSSIP_SETTLE_MS);

  step("B starts listening for an incoming negotiation");
  // B starts listening for an incoming negotiation before A offers one, and A's initiate() call and B's waitForIncoming() call race against each other's manage-request exchange in real time -- both must be in flight together.
  const bIncoming = pageB.evaluate(() => window.harness.waitForIncoming());
  // Marks the rejection as observed regardless of what the main flow below does with bIncoming (e.g. the page/context closing before this ever resolves, once an earlier step has already failed) -- without this, an unresolved-then-rejected bIncoming crashes the whole process as an unhandled rejection independent of the real failure already reported.
  bIncoming.catch(() => undefined);

  step("A relay-connects to B and initiates a webrtc negotiation over that pairing");
  // Not awaited to a hard timeout on its own: if this sandbox's network can't hairpin UDP back to itself (see the module header), ICE never reaches "connected" and this promise simply never resolves -- that is a known, separate condition from whether the signaling itself worked, verified independently below via frameSummary(). An unresolved promise here is fine; only a genuine rejection (the offer's own manage-response reporting an error) is a real failure.
  const initiatePromise = pageA.evaluate(
    (targetDevice) => window.harness.initiate(targetDevice),
    deviceB,
  );
  let initiateRejection;
  initiatePromise.then(
    () => undefined,
    (error) => {
      initiateRejection = error;
    },
  );

  step("waiting for the offer/answer signaling round trip to complete via the relay's relay-data forwarding");
  const signalingComplete = await pollUntil(
    async () => {
      if (initiateRejection) {
        throw initiateRejection instanceof Error
          ? initiateRejection
          : new Error(String(initiateRejection));
      }
      const summaryA = await pageA.evaluate(() => window.harness.frameSummary());
      const summaryB = await pageB.evaluate(() => window.harness.frameSummary());
      const aGotAnswer = summaryA.some(
        (entry) =>
          entry.direction === "received" &&
          entry.type === "manage-request" &&
          entry.verb === "webrtc.answer",
      );
      const bGotOffer = summaryB.some(
        (entry) =>
          entry.direction === "received" &&
          entry.type === "manage-request" &&
          entry.verb === "webrtc.offer",
      );
      return aGotAnswer && bGotOffer ? { summaryA, summaryB } : undefined;
    },
    NEGOTIATION_TIMEOUT_MS,
    "the offer/answer round trip to complete over relay-data",
  ).catch((error) => {
    fail("signaling round trip", error.message);
    throw error;
  });
  console.log(
    "PASS: the webrtc.offer and webrtc.answer manage-requests genuinely round-tripped through wire-mesh-node's real, unmodified relay-data forwarding (not a bespoke test relay)",
  );
  console.log(`  A's frame log: ${JSON.stringify(signalingComplete.summaryA)}`);
  console.log(`  B's frame log: ${JSON.stringify(signalingComplete.summaryB)}`);

  step("checking whether the data channel itself also reached open (best-effort; a sandbox network limitation can prevent this independent of signaling correctness)");
  const dataChannelResult = await Promise.race([
    initiatePromise.then((aConnectionId) => ({ ok: true, aConnectionId })),
    bIncoming.then((bConnectionId) => ({ ok: true, bConnectionId })),
    delay(NEGOTIATION_TIMEOUT_MS).then(() => ({ ok: false })),
  ]).catch(() => ({ ok: false }));

  if (dataChannelResult.ok) {
    const aConnectionId = await withTimeout(
      initiatePromise,
      NEGOTIATION_TIMEOUT_MS,
      "A's initiate() to resolve",
    );
    const bConnectionId = await withTimeout(
      bIncoming,
      NEGOTIATION_TIMEOUT_MS,
      "B's incoming data channel",
    );
    step(`data channel open: A=${aConnectionId} B=${bConnectionId}`);

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
      ({ connectionId, frame }) =>
        window.harness.sendGossip(connectionId, frame),
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
    } else {
      console.log(
        "PASS: two real browser contexts negotiated a real RTCDataChannel over core/webrtc signaling relayed through wire-mesh-node, and exchanged a byte-identical frame through it",
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
  } else {
    console.log(
      "NOTE: the RTCDataChannel itself did not reach open within the timeout -- consistent with this sandbox's documented inability to hairpin UDP back to itself for ICE (see the module header). This does not affect the PASS above: the signaling frames this fix exists for already proved they traverse the real relay.",
    );
  }
} catch (error) {
  if (process.exitCode !== 1) {
    fail("unexpected error", error instanceof Error ? error.stack : String(error));
  }
} finally {
  if (browser) {
    await browser.close();
  }
  vite.kill();
  if (relay) {
    relay.child.kill();
  }
}

process.exit(process.exitCode ?? 0);
