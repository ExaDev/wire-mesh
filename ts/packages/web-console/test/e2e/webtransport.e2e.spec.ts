// Two real Chromium browsers converse through a node they reach only over WebTransport, accepting its self-signed certificate by the hash in the address the node printed: no certificate authority, and nothing served over the internet. The console is served by vite on localhost, a secure context, so the only thing that could stop the connection is the pinned-hash handshake.

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
const NODE_START_TIMEOUT_MS = 20_000;
const STEP_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
/** How long the node is watched after the browsers disconnect: the package once threw from its own UDP handler when a session ended, taking the process down within moments. */
const DISCONNECT_WATCH_MS = 2000;
const FIRST_MESSAGE = "hello over webtransport";
const REPLY_MESSAGE = "reply over webtransport";

interface RunningNode {
  readonly address: string;
  readonly process: ChildProcess;
  readonly hasExited: () => boolean;
}

/** Starts the node with WebTransport on an OS-assigned UDP port and resolves with the pinned address it prints. */
async function startNode(): Promise<RunningNode> {
  const child = spawn(
    "node",
    [
      NODE_ENTRY,
      "--bind",
      LOOPBACK_ANY_PORT,
      "--webtransport",
      LOOPBACK_ANY_PORT,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout });
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
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  return { address, process: child, hasExited: () => exited };
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

test("two consoles converse through a node reached only by a pinned WebTransport hash", async () => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const node = await startNode();
  const first = await chromium.launch();
  const second = await chromium.launch();
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
