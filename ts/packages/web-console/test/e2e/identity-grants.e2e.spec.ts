// A real-browser check of the identity and grants surface with two independent console instances: one mints a grant for the other's device, the other adds it from its grant code, and the issuer revokes it. The identity backup is saved through the browser's own download flow and read back from the downloaded file, which has to carry the same device-id the page shows and must not have been put on the page.

import { readFile } from "node:fs/promises";
import { type Page, chromium, expect, test } from "@playwright/test";
import { VITE_PORT } from "../../playwright.config.js";

const TEST_TIMEOUT_MS = 60_000;

async function newConsole(
  browser: Readonly<Awaited<ReturnType<typeof chromium.launch>>>,
  appUrl: string,
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto(appUrl);

  return page;
}

async function ownDeviceId(page: Readonly<Page>): Promise<string> {
  await page.getByRole("button", { name: "Identity" }).click();

  return (await page.getByTestId("own-device-id").textContent()) ?? "";
}

test("a grant minted on one console is added on another and revoked by its issuer, and an identity backup carries the device's own id", async () => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const appUrl = `http://localhost:${String(VITE_PORT)}/`;
  const issuerBrowser = await chromium.launch();
  const bearerBrowser = await chromium.launch();
  try {
    const issuer = await newConsole(issuerBrowser, appUrl);
    const bearer = await newConsole(bearerBrowser, appUrl);
    const issuerId = await ownDeviceId(issuer);
    const bearerId = await ownDeviceId(bearer);
    expect(issuerId).toMatch(/^[0-9a-f]{64}$/);
    expect(bearerId).toMatch(/^[0-9a-f]{64}$/);
    expect(bearerId).not.toBe(issuerId);

    await issuer.getByRole("button", { name: "Grants" }).click();
    await issuer.getByLabel(/^Bearer device-id/).fill(bearerId);
    await issuer
      .getByRole("combobox", { name: /^Capability/ })
      .fill("room:member");
    await issuer.getByLabel(/^Scope path/).fill("a-room");
    await issuer.getByRole("button", { name: "Mint grant" }).click();
    const issued = issuer.getByTestId("grants-issued");
    await expect(issued.getByText("valid", { exact: true })).toBeVisible();
    await issued.getByRole("button", { name: "Inspect" }).click();
    const code = await issued.getByLabel("Grant code").inputValue();
    expect(code).toMatch(/^wm-grant1\./);

    await bearer.getByRole("button", { name: "Grants" }).click();
    await bearer.getByLabel(/^Grant code/).fill(code);
    await bearer.getByRole("button", { name: "Add grant" }).click();
    const held = bearer.getByTestId("grants-held");
    await expect(held.getByText("room:member")).toBeVisible();
    await expect(held.getByText("valid", { exact: true })).toBeVisible();

    await issued.getByRole("button", { name: "Revoke" }).click();
    await issued.getByRole("button", { name: /^Confirm: revoke/ }).click();
    await expect(issued.getByText("revoked", { exact: true })).toBeVisible();

    // The backup goes through the browser's download flow. The file names the device the page shows, and the page itself never shows the private key.
    await issuer.getByRole("button", { name: "Back up this identity" }).click();
    await issuer.getByLabel(/I understand/).check();
    const [download] = await Promise.all([
      issuer.waitForEvent("download"),
      issuer.getByRole("button", { name: "Save backup file" }).click(),
    ]);
    const downloaded = await download.path();
    const backup: unknown = JSON.parse(await readFile(downloaded, "utf8"));
    expect(backup).toMatchObject({
      format: "wire-mesh-console-identity",
      deviceId: issuerId,
    });
    const privateScalar =
      typeof backup === "object" &&
      backup !== null &&
      "privateJwk" in backup &&
      typeof backup.privateJwk === "object" &&
      backup.privateJwk !== null &&
      "d" in backup.privateJwk
        ? backup.privateJwk.d
        : undefined;
    expect(typeof privateScalar).toBe("string");
    expect(await issuer.locator("body").innerText()).not.toContain(
      String(privateScalar),
    );
  } finally {
    await Promise.all([issuerBrowser.close(), bearerBrowser.close()]);
  }
});
