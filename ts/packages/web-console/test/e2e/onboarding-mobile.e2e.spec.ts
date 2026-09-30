// A real-browser check of the first-run intro and the phone layout, against a real relay and two independent console instances: a device's intro appears once and stays dismissed after a reload, and on a phone-width viewport the peer directory, which has a real row because a second console is connected, stacks into a card that fits the screen, where the same table on a desktop-width viewport keeps its columns.

import { type Page, chromium, expect, test } from "@playwright/test";
import { RELAY_ADDRESS, VITE_PORT } from "../../playwright.config.js";

const PHONE_VIEWPORT = { width: 360, height: 640 };
const DIRECTORY_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;

/** Whether the page fits its viewport horizontally: a table too wide for a phone widens the document past it. */
async function fitsViewportWidth(page: Readonly<Page>): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
}

/** How the browser lays out a directory cell: a table cell on a wide screen, a block once the row has stacked into a card. */
async function directoryCellDisplay(page: Readonly<Page>): Promise<string> {
  return page
    .locator('td[data-label="device"]')
    .first()
    .evaluate((cell) => getComputedStyle(cell).display);
}

test("the intro shows once per device, and the directory stacks into cards on a phone screen", async () => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const appUrl = `http://localhost:${String(VITE_PORT)}/`;
  const phoneBrowser = await chromium.launch();
  const peerBrowser = await chromium.launch();
  try {
    const phone = await (
      await phoneBrowser.newContext({ viewport: PHONE_VIEWPORT })
    ).newPage();
    phone.on("pageerror", (error) => {
      throw error;
    });
    const peer = await (await peerBrowser.newContext()).newPage();
    peer.on("pageerror", (error) => {
      throw error;
    });

    await phone.goto(appUrl);
    await expect(phone.getByTestId("onboarding-intro")).toBeVisible();
    await phone.getByRole("button", { name: "Got it" }).click();
    await expect(phone.getByTestId("onboarding-intro")).toBeHidden();
    await phone.reload();
    await expect(
      phone.getByRole("button", { name: "How this works" }),
    ).toBeVisible();
    await expect(phone.getByTestId("onboarding-intro")).toBeHidden();

    await peer.goto(appUrl);
    for (const page of [phone, peer]) {
      await page.getByLabel("Node").fill(RELAY_ADDRESS);
      await page.getByRole("button", { name: "Connect" }).click();
    }

    const messageButton = phone.getByRole("button", { name: "Message" });
    await expect(messageButton).toBeVisible({ timeout: DIRECTORY_TIMEOUT_MS });
    expect(await fitsViewportWidth(phone)).toBe(true);
    expect(await directoryCellDisplay(phone)).toBe("block");
    await expect(peer.getByRole("button", { name: "Message" })).toBeVisible({
      timeout: DIRECTORY_TIMEOUT_MS,
    });
    expect(await directoryCellDisplay(peer)).toBe("table-cell");
    const box = await messageButton.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      PHONE_VIEWPORT.width,
    );
  } finally {
    await Promise.all([phoneBrowser.close(), peerBrowser.close()]);
  }
});
