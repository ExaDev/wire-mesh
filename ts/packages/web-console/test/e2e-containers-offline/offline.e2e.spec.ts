// One side of a conversation between two consoles that have no route to the internet. Phase "warm" loads the console from the cloud container so its service worker caches the app shell. Phase "connect" runs after the cloud has been stopped: the console must load from the cache, and both sides then connect to the LAN node at NODE_ADDRESS and exchange a message each way, as in test/e2e-containers. TRUST_LAN_NODE=spki tells the browser to accept the LAN node's certificate by the hash of its public key, which stands in for a certificate the browser's own trust store would accept.

import { readFileSync } from "node:fs";
import { chromium, expect, test, type Page } from "@playwright/test";

const STEP_TIMEOUT_MS = 60_000;
const FIRST_MESSAGE = "hello from the initiator container";
const REPLY_MESSAGE = "reply from the responder container";
const PROFILE_DIR = "/profile";
const LAN_NODE_SPKI_FILE = "/certs/lan-node.spki";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set`);
  }
  return value;
}

const cloudOrigin = requiredEnvironment("CLOUD_ORIGIN");
const role = requiredEnvironment("PEER_ROLE");
const phase = requiredEnvironment("PEER_PHASE");

function launchArguments(): string[] {
  if (phase === "warm") {
    // A service worker will not register on an origin whose certificate the browser rejects.
    return ["--ignore-certificate-errors"];
  }
  if (process.env.TRUST_LAN_NODE === "spki") {
    const spki = readFileSync(LAN_NODE_SPKI_FILE, "utf8").trim();
    return [`--ignore-certificate-errors-spki-list=${spki}`];
  }
  return [];
}

async function openConsole(): Promise<Page> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    args: launchArguments(),
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("console", (message) => {
    console.log(`[${role} console] ${message.text()}`);
  });
  await page.goto(cloudOrigin);
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

if (phase === "warm") {
  test("caches the console for offline use", async () => {
    const page = await openConsole();
    await page.evaluate(async () => navigator.serviceWorker.ready);
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const names = await caches.keys();
            let entries = 0;
            for (const name of names) {
              entries += (await (await caches.open(name)).keys()).length;
            }
            return entries;
          }),
        { timeout: STEP_TIMEOUT_MS },
      )
      .toBeGreaterThan(0);
    await page.context().close();
  });
} else if (phase === "connect") {
  test("loads from the cache and converses through the LAN node", async () => {
    const page = await openConsole();
    // The cloud is stopped, so this only renders if the service worker served it.
    await expect(page.getByLabel("Node")).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });
    await page.getByLabel("Node").fill(requiredEnvironment("NODE_ADDRESS"));
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    if (role === "initiator") {
      await page
        .getByRole("button", { name: "Message", exact: true })
        .click({ timeout: STEP_TIMEOUT_MS });
      await expect(
        page.getByPlaceholder("Message", { exact: true }),
      ).toBeVisible({ timeout: STEP_TIMEOUT_MS });
      await send(page, FIRST_MESSAGE);
      await allowRequest(page);
      await expect(page.getByText(REPLY_MESSAGE, { exact: true })).toBeVisible({
        timeout: STEP_TIMEOUT_MS,
      });
    } else {
      await allowRequest(page);
      await expect(page.getByText(FIRST_MESSAGE, { exact: true })).toBeVisible({
        timeout: STEP_TIMEOUT_MS,
      });
      await send(page, REPLY_MESSAGE);
      await expect(
        page.getByText(/Waiting for .* to allow messages/),
      ).toBeHidden({ timeout: STEP_TIMEOUT_MS });
      await expect(
        page.getByText(REPLY_MESSAGE, { exact: true }),
      ).toBeVisible();
    }
    await page.context().close();
  });
} else {
  throw new Error(`PEER_PHASE must be "warm" or "connect", got "${phase}"`);
}
