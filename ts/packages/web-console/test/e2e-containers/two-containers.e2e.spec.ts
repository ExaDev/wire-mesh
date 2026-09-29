// One side of a conversation between two consoles that each run in a container of their own (compose.yaml), on one Docker network with a hub. The same file runs in both containers and PEER_ROLE says which side this one plays: the initiator opens a conversation with the only other peer on the hub and sends the first message, the responder allows it and replies, and the initiator allows the reply. Each side's assertions are what proves the exchange reached it, so the run only passes if a message crossed in both directions between two separate network stacks with Chrome's default handling of local addresses.

import { expect, test, type Page } from "@playwright/test";

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

async function connect(page: Readonly<Page>): Promise<void> {
  await page.goto(hubOrigin);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
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
    // The reply is only delivered once the initiator allows it, so it leaves the waiting state.
    await expect(page.getByText(/Waiting for .* to allow messages/)).toBeHidden(
      { timeout: STEP_TIMEOUT_MS },
    );
    await expect(page.getByText(REPLY_MESSAGE, { exact: true })).toBeVisible();
  });
} else {
  throw new Error(
    `PEER_ROLE must be "initiator" or "responder", got "${role}"`,
  );
}
