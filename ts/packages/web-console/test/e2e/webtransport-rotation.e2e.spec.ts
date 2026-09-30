// A conversation that is under way when the node rotates its certificate. The node replaces its WebTransport server at each rotation, which ends the sessions open on it, so both consoles must reconnect by themselves, over the address they were given, and a message sent afterwards must still arrive. The certificate lifetime is short so the rotation happens within the test.

import { chromium, expect, test } from "@playwright/test";
import {
  NO_DIRECT_CONNECTION_ARGS,
  STEP_TIMEOUT_MS,
  converse,
  expectReconnected,
  handshakesSent,
  openConsole,
  send,
  startNode,
} from "./webtransport-support.js";

/** Half of this is how long each certificate serves, so the first rotation comes half this many seconds after the node starts, which leaves the conversation before it time to finish. */
const CERTIFICATE_LIFETIME_SECONDS = 40;
const ROTATION_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;

test("a conversation continues across a certificate rotation without pasting a new address", async () => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const node = await startNode(CERTIFICATE_LIFETIME_SECONDS);
  const first = await chromium.launch({ args: NO_DIRECT_CONNECTION_ARGS });
  const second = await chromium.launch({ args: NO_DIRECT_CONNECTION_ARGS });
  try {
    const initiator = await openConsole(first, node.address);
    const responder = await openConsole(second, node.address);
    await converse(
      initiator,
      responder,
      "hello before the rotation",
      "reply before the rotation",
    );

    // The node replaces its server, so both consoles lose their session and come back over the address they were given.
    const before = [
      await handshakesSent(initiator),
      await handshakesSent(responder),
    ];
    await node.nextRotation();
    await expectReconnected(initiator, before[0] ?? 0, 1, ROTATION_TIMEOUT_MS);
    await expectReconnected(responder, before[1] ?? 0, 1, ROTATION_TIMEOUT_MS);

    await send(responder, "sent after the rotation");
    await expect(
      initiator.getByText("sent after the rotation", { exact: true }),
    ).toBeVisible({ timeout: STEP_TIMEOUT_MS });
  } finally {
    await first.close();
    await second.close();
    node.process.kill();
  }
});
