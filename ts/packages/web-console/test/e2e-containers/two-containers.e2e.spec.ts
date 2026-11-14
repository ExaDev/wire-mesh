// One side of a conversation between two consoles that each run in a container of their own (compose.yaml), on one Docker network with a hub. The same file runs in both containers and PEER_ROLE says which side this one plays: the initiator opens a conversation with the only other peer on the hub and sends the first message, the responder allows it and replies, and the initiator allows the reply. Each side's assertions are what proves the exchange reached it, so the run only passes if a message crossed in both directions between two separate network stacks with Chrome's default handling of local addresses.

import { expect, test, type Locator, type Page } from "@playwright/test";

const STEP_TIMEOUT_MS = 60_000;
const FIRST_MESSAGE = "hello from the initiator container";
const REPLY_MESSAGE = "reply from the responder container";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set`);
  }

  return value;
}

const hubOrigin = requiredEnvironment("HUB_ORIGIN");
const role = requiredEnvironment("PEER_ROLE");

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    console.log(`[${role} console] ${message.text()}`);
  });
});

// The page as the user would see it, so a failed exchange shows what each side had on screen.
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    console.log(
      `[${role} page at failure]\n${await page.locator("body").ariaSnapshot()}`,
    );
  }
});

async function connect(page: Readonly<Page>): Promise<void> {
  await page.goto(hubOrigin);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}

async function send(page: Readonly<Page>, text: string): Promise<void> {
  await page.getByPlaceholder("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

/** The time shown with a message, which only a message in the conversation's history has: a message still held for consent or in flight is listed without one, whatever else is shown for it. */
function delivered(page: Readonly<Page>, text: string): Locator {
  return page
    .getByText(text, { exact: true })
    .locator("xpath=following-sibling::time");
}

async function allowRequest(page: Readonly<Page>): Promise<void> {
  await expect(page.getByText("wants to message you")).toBeVisible({
    timeout: STEP_TIMEOUT_MS,
  });
  await page.getByRole("button", { name: "Allow" }).click();
}

if (role === "initiator") {
  test("opens a conversation, sends the first message, and allows and receives the reply", async ({
    page,
  }) => {
    await connect(page);
    // Nobody else is on this hub, so the one peer in the directory is the responder.
    await page
      .getByRole("button", { name: "Message", exact: true })
      .click({ timeout: STEP_TIMEOUT_MS });
    await expect(page.getByPlaceholder("Message", { exact: true })).toBeVisible(
      { timeout: STEP_TIMEOUT_MS },
    );
    await send(page, FIRST_MESSAGE);

    // The responder replies once it has allowed messages, which asks this side in turn.
    await allowRequest(page);
    await expect(page.getByText(REPLY_MESSAGE, { exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });
  });
} else if (role === "responder") {
  test("allows the first message, receives it, and replies", async ({
    page,
  }) => {
    await connect(page);
    await allowRequest(page);
    await expect(page.getByText(FIRST_MESSAGE, { exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });
    await send(page, REPLY_MESSAGE);
    // The test ending closes the browser, so this waits until the reply has been delivered (it is sent only once the initiator has allowed it), which is when it moves into the history and shows a time; the reply text alone is on screen from the moment it is typed.
    await expect(delivered(page, REPLY_MESSAGE)).toBeVisible({
      timeout: STEP_TIMEOUT_MS,
    });
  });
} else {
  throw new Error(
    `PEER_ROLE must be "initiator" or "responder", got "${role}"`,
  );
}
