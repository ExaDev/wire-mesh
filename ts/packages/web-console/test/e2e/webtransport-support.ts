// What the WebTransport end-to-end specs share: a node started with WebTransport on an OS-assigned UDP port, and the console's real UI driven through the steps of a conversation.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { type Browser, type Page, expect } from "@playwright/test";
import { VITE_PORT } from "../../playwright.config.js";

const NODE_ENTRY = new URL("../../../node/dist/server.mjs", import.meta.url)
  .pathname;
const LOOPBACK_ANY_PORT = "127.0.0.1:0";
const ADDRESS_LINE = /wire-mesh serving WebTransport at (\S+)/;
const ROTATION_LINE = "wire-mesh WebTransport addresses changed";
const NODE_START_TIMEOUT_MS = 20_000;
export const STEP_TIMEOUT_MS = 30_000;

/** No UDP candidates at all, so ICE has nothing to connect with and two consoles cannot upgrade to a direct connection: every message has to cross the node. */
export const NO_DIRECT_CONNECTION_ARGS = [
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];

export interface RunningNode {
  /** The pinned address the node printed first. */
  readonly address: string;
  readonly process: ChildProcess;
  /** Whether the node process has exited. */
  readonly hasExited: () => boolean;
  /** Resolves the next time the node reports that its certificate rotated. */
  readonly nextRotation: () => Promise<void>;
}

/** Starts the node with WebTransport, and a certificate lifetime when the spec wants rotation within the test. */
export async function startNode(
  certificateLifetimeSeconds?: number,
): Promise<RunningNode> {
  const child = spawn(
    "node",
    [
      NODE_ENTRY,
      "--bind",
      LOOPBACK_ANY_PORT,
      "--webtransport",
      LOOPBACK_ANY_PORT,
      ...(certificateLifetimeSeconds === undefined
        ? []
        : ["--certificate-lifetime", String(certificateLifetimeSeconds)]),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const lines = createInterface({ input: child.stdout });
  const rotationWaiters: (() => void)[] = [];
  lines.on("line", (line) => {
    if (line.includes(ROTATION_LINE)) {
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
    hasExited: () => exited,
    nextRotation: async () =>
      new Promise<void>((resolve) => {
        rotationWaiters.push(resolve);
      }),
  };
}

/** A console in a browser context of its own, connected to `nodeAddress` through the real connect form. */
export async function openConsole(
  browser: Readonly<Browser>,
  nodeAddress: string,
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`http://localhost:${String(VITE_PORT)}/`);
  await page.getByLabel("Node").fill(nodeAddress);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  return page;
}

export async function send(page: Readonly<Page>, text: string): Promise<void> {
  await page.getByPlaceholder("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

export async function allowRequest(page: Readonly<Page>): Promise<void> {
  await expect(page.getByText("wants to message you")).toBeVisible({
    timeout: STEP_TIMEOUT_MS,
  });
  await page.getByRole("button", { name: "Allow" }).click();
}

/** The opening exchange: the initiator messages the only other peer, the responder allows and replies, the initiator allows the reply. */
export async function converse(
  initiator: Readonly<Page>,
  responder: Readonly<Page>,
  first: string,
  reply: string,
): Promise<void> {
  await initiator
    .getByRole("button", { name: "Message", exact: true })
    .click({ timeout: STEP_TIMEOUT_MS });
  await send(initiator, first);
  await allowRequest(responder);
  await expect(responder.getByText(first, { exact: true })).toBeVisible({
    timeout: STEP_TIMEOUT_MS,
  });
  await send(responder, reply);
  await allowRequest(initiator);
  await expect(initiator.getByText(reply, { exact: true })).toBeVisible({
    timeout: STEP_TIMEOUT_MS,
  });
}

/** How many times this console has sent its handshake, which it does once for every connection it makes, so the count rises by one for each reconnect that succeeds. */
export async function handshakesSent(page: Readonly<Page>): Promise<number> {
  return page
    .locator("table tbody tr", { hasText: /^sent\{"type":"handshake"/ })
    .count();
}

/** Waits until `page` has made `reconnects` more connections than the `before` it recorded, and shows itself connected: waiting on the status alone passes on the stale "connected" left over from the session that just ended. */
export async function expectReconnected(
  page: Readonly<Page>,
  before: number,
  reconnects: number,
  timeoutMs: number,
): Promise<void> {
  try {
    await expect
      .poll(async () => handshakesSent(page), { timeout: timeoutMs })
      .toBeGreaterThanOrEqual(before + reconnects);
  } catch (error) {
    const status = await page
      .locator("p", { hasText: /^(connecting|connected|reconnecting|closed)/ })
      .first()
      .textContent();
    throw new Error(
      `the console made ${String((await handshakesSent(page)) - before)} of ${String(reconnects)} new connections and shows "${status ?? ""}"`,
      { cause: error },
    );
  }
  await expect(page.getByText(/^connected/)).toBeVisible();
}
