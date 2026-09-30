// Two real Chromium browsers converse through a node they reach only over WebTransport, accepting its self-signed certificate by the hash in the address the node printed: no certificate authority, and nothing served over the internet. The console is served by vite on localhost, a secure context, so the only thing that could stop the connection is the pinned-hash handshake.

import { chromium, expect, test } from "@playwright/test";
import { converse, openConsole, startNode } from "./webtransport-support.js";

const TEST_TIMEOUT_MS = 90_000;
/** How long the node is watched after the browsers disconnect: the package once threw from its own UDP handler when a session ended, taking the process down within moments. */
const DISCONNECT_WATCH_MS = 2000;

test("two consoles converse through a node reached only by a pinned WebTransport hash", async () => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const node = await startNode();
  const first = await chromium.launch();
  const second = await chromium.launch();
  try {
    const initiator = await openConsole(first, node.address);
    const responder = await openConsole(second, node.address);
    await converse(
      initiator,
      responder,
      "hello over webtransport",
      "reply over webtransport",
    );
    await first.close();
    await second.close();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DISCONNECT_WATCH_MS);
    });
    expect(node.hasExited()).toBe(false);
  } finally {
    await first.close();
    await second.close();
    node.process.kill();
  }
});
