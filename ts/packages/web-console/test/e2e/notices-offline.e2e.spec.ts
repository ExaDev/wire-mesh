// A notice posted while the other device is offline is still there when that device comes back (wire-mesh#274). Two independent consoles connect to a hub that holds logs for absent devices, with no direct connection possible between them, so everything that reaches the second device does so through the hub. The second device closes its page, the first posts, and the second opens the console again over the same storage: its stored token, epoch key and conversation survive the restart, and the hub hands it the log it missed.

import {
  type BrowserContext,
  type Page,
  chromium,
  expect,
  test,
} from "@playwright/test";
import { MAILBOX_RELAY_ADDRESS, VITE_PORT } from "../../playwright.config.js";

// No UDP candidates at all, so no direct connection can open between the two browsers.
const NO_DIRECT_CONNECTION_ARGS = [
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];
const TEST_TIMEOUT_MS = 90_000;
const STEP_TIMEOUT_MS = 15_000;
const FIRST_NOTICE = "first notice, written while both are online";
const OFFLINE_NOTICE = "second notice, written while the other is away";
const MESSAGE_TEXT = "hello";
const REPLY_TEXT = "hello back";

// A click or fill that cannot find its target fails at its own line instead of consuming the whole test timeout.
test.use({ actionTimeout: STEP_TIMEOUT_MS });

async function openConsole(context: Readonly<BrowserContext>): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto(
    new URL("/", `http://localhost:${String(VITE_PORT)}`).toString(),
  );
  await page.getByLabel("Node").fill(MAILBOX_RELAY_ADDRESS);
  await page.getByRole("button", { name: "Connect" }).click();

  return page;
}

/** Posts through the composer's Enter key: the "Ready to work offline" toast a fresh console shows can sit over the Post button. */
async function postNotice(page: Readonly<Page>, text: string): Promise<void> {
  const composer = page.getByPlaceholder("Post a durable notice");
  await composer.fill(text);
  await composer.press("Enter");
}

test("a notice written while the peer is offline is read after the peer reloads", async () => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const browserA = await chromium.launch({ args: NO_DIRECT_CONNECTION_ARGS });
  const browserB = await chromium.launch({ args: NO_DIRECT_CONNECTION_ARGS });
  try {
    const contextA = await browserA.newContext();
    const contextB = await browserB.newContext();
    const pageA = await openConsole(contextA);
    const pageB = await openConsole(contextB);

    const messageButton = pageA.getByRole("button", { name: "Message" });
    await expect(messageButton).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expect(pageB.getByRole("button", { name: "Message" })).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });
    await messageButton.click();

    // Consent runs in each direction, and each side then holds a token for the conversation.
    await pageA.getByPlaceholder("Message", { exact: true }).fill(MESSAGE_TEXT);
    await pageA.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pageB.getByText("wants to message you")).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });
    await pageB.getByRole("button", { name: "Allow" }).click();
    await expect(pageB.getByText(MESSAGE_TEXT, { exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });
    await pageB.getByPlaceholder("Message", { exact: true }).fill(REPLY_TEXT);
    await pageB.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pageA.getByText("wants to message you")).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });
    await pageA.getByRole("button", { name: "Allow" }).click();
    await expect(pageA.getByText(REPLY_TEXT, { exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });

    // The first notice is posted with both online: it hands B the conversation's key through the hub.
    await postNotice(pageA, FIRST_NOTICE);
    await expect(pageA.getByText(FIRST_NOTICE, { exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });

    // B goes away; A writes a second notice that only the hub can hold for it.
    await pageB.close();
    await postNotice(pageA, OFFLINE_NOTICE);
    await expect(pageA.getByText(OFFLINE_NOTICE, { exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });

    // B comes back on the same storage and reconnects: both notices are read, the second one from the hub.
    const reopenedB = await openConsole(contextB);
    await expect(
      reopenedB.getByText(OFFLINE_NOTICE, { exact: true }),
    ).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expect(
      reopenedB.getByText(FIRST_NOTICE, { exact: true }),
    ).toBeVisible({ timeout: STEP_TIMEOUT_MS });
  } finally {
    await Promise.all([browserA.close(), browserB.close()]);
  }
});
