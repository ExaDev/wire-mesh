// A console that stays open for longer than the address it was given lists certificates for. An address holds the hashes of the certificate served when it was made and the next two, so once the node has rotated past all three the address alone can no longer reach it. The node announces its current hashes to each session, and the console dials with the latest, so a conversation goes on across more rotations than the address ever listed.

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

/** Each certificate serves for half of this, so every rotation comes this many seconds divided by two after the last. */
const CERTIFICATE_LIFETIME_SECONDS = 24;
/** One more rotation than an address lists certificates for: the serving certificate and the next two make three, so after the third rotation the address's own hashes match nothing the node serves. */
const ROTATIONS = 4;
const ROTATION_TIMEOUT_MS = 30_000;
/** Long enough that the inner waits, each with its own message, give out before the test does. */
const TEST_TIMEOUT_MS = 360_000;

test("a console keeps reconnecting after the node has rotated past every hash in the address it was given", async () => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const node = await startNode(CERTIFICATE_LIFETIME_SECONDS);
  const first = await chromium.launch({ args: NO_DIRECT_CONNECTION_ARGS });
  const second = await chromium.launch({ args: NO_DIRECT_CONNECTION_ARGS });
  try {
    const initiator = await openConsole(first, node.address);
    const responder = await openConsole(second, node.address);
    await test.step("converse before any rotation", async () => {
      await converse(
        initiator,
        responder,
        "hello before any rotation",
        "reply before any rotation",
      );
    });

    const before = [
      await handshakesSent(initiator),
      await handshakesSent(responder),
    ];
    for (let rotation = 1; rotation <= ROTATIONS; rotation++) {
      await test.step(`wait for rotation ${String(rotation)}`, async () => {
        await node.nextRotation();
      });
    }
    // Every rotation ends the session and the console makes a new one, so each has to have succeeded, the last after the address's own hashes matched nothing.
    await test.step("both consoles reconnected every time", async () => {
      await expectReconnected(
        initiator,
        before[0] ?? 0,
        ROTATIONS,
        ROTATION_TIMEOUT_MS,
      );
      await expectReconnected(
        responder,
        before[1] ?? 0,
        ROTATIONS,
        ROTATION_TIMEOUT_MS,
      );
    });

    await test.step("a message after every hash in the address had gone", async () => {
      await send(responder, "sent after every hash in the address had gone");
      await expect(
        initiator.getByText("sent after every hash in the address had gone", {
          exact: true,
        }),
      ).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    });
  } finally {
    await first.close();
    await second.close();
    node.process.kill();
  }
});
