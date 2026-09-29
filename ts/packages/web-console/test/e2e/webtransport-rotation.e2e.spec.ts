// A conversation that is under way when the node rotates its certificate. The node replaces its WebTransport server at each rotation, which ends the sessions open on it, so both consoles must reconnect by themselves, over the same address they were given, and a message sent afterwards must still arrive. The certificate lifetime is short so the rotation happens within the test.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  type Browser,
  type Page,
  chromium,
  expect,
  test,
} from "@playwright/test";
import { VITE_PORT } from "../../playwright.config.js";

const NODE_ENTRY = new URL("../../../node/dist/server.mjs", import.meta.url)
  .pathname;
const LOOPBACK_ANY_PORT = "127.0.0.1:0";
const ADDRESS_LINE = /wire-mesh serving WebTransport at (\S+)/;
/** Half of this is how long each certificate serves, so the first rotation comes half this many seconds after the node starts, which leaves the conversation before it time to finish. */
const CERTIFICATE_LIFETIME_SECONDS = 40;
const NODE_START_TIMEOUT_MS = 20_000;
const STEP_TIMEOUT_MS = 30_000;
const ROTATION_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;

// No UDP candidates at all, so ICE has nothing to connect with and the two consoles cannot upgrade to a direct connection: every message has to cross the node, which is the session the rotation ends.
const NO_DIRECT_CONNECTION_ARGS = [
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];
const FIRST_MESSAGE = "hello before the rotation";
const REPLY_MESSAGE = "reply before the rotation";
const AFTER_MESSAGE = "sent after the rotation";

interface RunningNode {
  readonly address: string;
  readonly process: ChildProcess;
  /** Resolves the next time the node reports that its certificate rotated. */
  readonly nextRotation: () => Promise<void>;
}

async function startNode(): Promise<RunningNode> {
  const child = spawn(
    "node",
    [
      NODE_ENTRY,
      "--bind",
      LOOPBACK_ANY_PORT,
      "--webtransport",
      LOOPBACK_ANY_PORT,
      "--certificate-lifetime",
      String(CERTIFICATE_LIFETIME_SECONDS),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout });
  const rotationWaiters: (() => void)[] = [];
  lines.on("line", (line) => {
    if (line.includes("wire-mesh WebTransport addresses changed")) {
      for (const waiter of rotationWaiters.splice(0)) {
        waiter();
      }
    }
  });
  const address = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the node did not print its WebTransport address"));
    }, NODE_START_TIMEOUT_MS);
    lines.on("line", (line) => {
      const match = ADDRESS_LINE.exec(line);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the node exited with code ${String(code)}`));
    });
  });
  return {
    address,
    process: child,
    nextRotation: async () =>
      new Promise<void>((resolve) => {
        rotationWaiters.push(resolve);
      }),
  };
}

async function openConsole(
  browser: Readonly<Browser>,
  nodeAddress: string,
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`http://localhost:${String(VITE_PORT)}/`);
  await page.getByLabel("Node").fill(nodeAddress);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  return page;
}

async function send(page: Readonly<Page>, text: string): Promise<void> {
  await page.getByPlaceholder("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

async function allowRequest(page: Readonly<Page>): Promise<void> {
  await expect(page.getByText("wants to message you")).toBeVisible({
    timeout: STEP_TIMEOUT_MS,
  });
  await page.getByRole("button", { name: "Allow" }).click();
}

test("a conversation continues across a certificate rotation without pasting a new address", async () => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const node = await startNode();
  const first = await chromium.launch({ args: NO_DIRECT_CONNECTION_ARGS });
  const second = await chromium.launch({ args: NO_DIRECT_CONNECTION_ARGS });
  try {
    const initiator = await openConsole(first, node.address);
    const responder = await openConsole(second, node.address);

    await initiator
      .getByRole("button", { name: "Message", exact: true })
      .click({ timeout: STEP_TIMEOUT_MS });
    await send(initiator, FIRST_MESSAGE);
    await allowRequest(responder);
    await expect(
      responder.getByText(FIRST_MESSAGE, { exact: true }),
    ).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await send(responder, REPLY_MESSAGE);
    await allowRequest(initiator);
    await expect(
      initiator.getByText(REPLY_MESSAGE, { exact: true }),
    ).toBeVisible({ timeout: STEP_TIMEOUT_MS });

    // The node replaces its server, so both consoles lose their session and come back over the address they were given.
    await node.nextRotation();
    for (const page of [initiator, responder]) {
      await expect(page.getByText(/^connected/)).toBeVisible({
        timeout: ROTATION_TIMEOUT_MS,
      });
    }

    await send(responder, AFTER_MESSAGE);
    await expect(
      initiator.getByText(AFTER_MESSAGE, { exact: true }),
    ).toBeVisible({ timeout: STEP_TIMEOUT_MS });
  } finally {
    await first.close();
    await second.close();
    node.process.kill();
  }
});
