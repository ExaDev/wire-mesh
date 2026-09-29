// A real, checked-in end-to-end test for the actual console UI's room-messaging flow (wire-mesh#101) -- webrtc.spec.ts already proves the raw WebRTC/relay signaling works against a bare test harness page; this drives the real production App/ConnectionPanel/RoomPanel components instead, the way a person actually uses the console: two independent browser instances, each its own persisted identity, connect to a real relay, one clicks "Message" on the other's directory row and sends a message, the other approves the resulting request, and the message renders on the receiving side -- with no manually copy-pasted token anywhere in the flow.
//
// A conversation opens at once over the hub both browsers are connected to, and a direct WebRTC connection is negotiated in the background and takes over when it opens. Two cases pin both halves, each asserting every step unconditionally: with the flags in SAME_MACHINE_WEBRTC_ARGS, which let ICE complete on a single host, the conversation must end up direct; with UDP candidates forbidden, so no direct connection can open, the whole exchange must still work through the hub and stay there.

import {
  type Browser,
  type Page,
  chromium,
  expect,
  test,
} from "@playwright/test";
import { RELAY_ADDRESS, VITE_PORT } from "../../playwright.config.js";

// Mirrors playwright.config.ts's own `use.launchOptions.args` -- see webrtc.spec.ts's identical constant for why a directly-launched browser needs these repeated explicitly.
const SAME_MACHINE_WEBRTC_ARGS = [
  "--disable-features=WebRtcHideLocalIpsWithMdns",
  "--allow-loopback-in-peer-connection",
];

const APP_URL_PATH = "/";
const DIRECTORY_TIMEOUT_MS = 15_000;
const ROOM_PANEL_TIMEOUT_MS = 15_000;
const MESSAGE_RENDER_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 60_000;
const DIRECT_UPGRADE_TIMEOUT_MS = 20_000;
const DIRECT_UPGRADE_GRACE_MS = 5000;
const TEST_MESSAGE_TEXT = "hello from the e2e test";
const TEST_REPLY_TEXT = "reply from the e2e test";

// No UDP candidates at all, so ICE has nothing to connect with and no direct connection can open between the two browsers.
const NO_DIRECT_CONNECTION_ARGS = [
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];

/** A genuinely separate Chromium process per device, matching webrtc.spec.ts's own launchDeviceBrowser -- separate storage/IndexedDB/identity, and no shared browser process either, so each side's createPersistedWebCryptoIdentity() call in main.tsx mints its own distinct device-id. */
async function launchDeviceBrowser(args: readonly string[]): Promise<Browser> {
  return chromium.launch({ args: [...args] });
}

async function newDevicePage(browser: Readonly<Browser>): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  return page;
}

/** Fills the console's own connect form and submits it -- the real UI path, not a scripted session.connect() call. */
async function connectConsole(
  page: Readonly<Page>,
  address: string,
): Promise<void> {
  await page.getByLabel("Node").fill(address);
  await page.getByRole("button", { name: "Connect" }).click();
}

async function inTwoBrowsers(
  args: readonly string[],
  run: (
    browserA: Readonly<Browser>,
    browserB: Readonly<Browser>,
    appUrl: string,
  ) => Promise<void>,
): Promise<void> {
  test.setTimeout(TEST_TIMEOUT_MS);
  const appUrl = new URL(
    APP_URL_PATH,
    `http://localhost:${String(VITE_PORT)}`,
  ).toString();
  const browserA = await launchDeviceBrowser(args);
  const browserB = await launchDeviceBrowser(args);
  try {
    await run(browserA, browserB, appUrl);
  } finally {
    await Promise.all([browserA.close(), browserB.close()]);
  }
}

test("two independent console instances see each other, message, approve, and render the reply through the real UI, ending on a direct connection", async () => {
  await inTwoBrowsers(
    SAME_MACHINE_WEBRTC_ARGS,
    async (browserA, browserB, appUrl) => {
      const [pageA, pageB] = await runRoomMessagingTest(
        browserA,
        browserB,
        appUrl,
      );
      // The conversation started over the hub; the direct connection takes it over once it opens.
      await expect(pageA.getByText("direct", { exact: true })).toBeVisible({
        timeout: DIRECT_UPGRADE_TIMEOUT_MS,
      });
      await expect(pageB.getByText("direct", { exact: true })).toBeVisible({
        timeout: DIRECT_UPGRADE_TIMEOUT_MS,
      });
    },
  );
});

test("the same exchange works through the hub alone when no direct connection can open, and stays on the hub", async () => {
  await inTwoBrowsers(
    NO_DIRECT_CONNECTION_ARGS,
    async (browserA, browserB, appUrl) => {
      const [pageA, pageB] = await runRoomMessagingTest(
        browserA,
        browserB,
        appUrl,
      );
      // Long enough for a direct connection to have opened if it could: it must not have, and the conversation must not have moved.
      await pageA.waitForTimeout(DIRECT_UPGRADE_GRACE_MS);
      await expect(pageA.getByText("via hub", { exact: true })).toBeVisible();
      await expect(pageB.getByText("via hub", { exact: true })).toBeVisible();
      await expect(pageA.getByText("direct", { exact: true })).toBeHidden();
    },
  );
});

async function runRoomMessagingTest(
  browserA: Readonly<Browser>,
  browserB: Readonly<Browser>,
  appUrl: string,
): Promise<[Page, Page]> {
  const pageA = await newDevicePage(browserA);
  const pageB = await newDevicePage(browserB);

  await pageA.goto(appUrl);
  await pageB.goto(appUrl);

  await connectConsole(pageA, RELAY_ADDRESS);
  await connectConsole(pageB, RELAY_ADDRESS);

  // Each side's own gossip self-advert must reach the relay and be forwarded to the other before either directory table shows a "Message" button at all -- the same real, connection-independent settle time webrtc.spec.ts's own GOSSIP_SETTLE_MS documents, expressed here as a poll rather than a fixed sleep since this is the real UI re-rendering from useMeshSessionEvents. Scoped to the "Message" button specifically, not a generic table row -- ConnectionPanel also renders a separate frame-log table, whose own rows carry no such button but would otherwise be indistinguishable from a directory row by a bare "table tbody tr" locator.
  const messageButtonA = pageA.getByRole("button", { name: "Message" });
  const messageButtonB = pageB.getByRole("button", { name: "Message" });
  await expect(messageButtonA).toBeVisible({ timeout: DIRECTORY_TIMEOUT_MS });
  await expect(messageButtonB).toBeVisible({ timeout: DIRECTORY_TIMEOUT_MS });

  // A clicks "Message" on B's directory row: the conversation opens at once over the hub, and a direct connection is negotiated behind it.
  await messageButtonA.click();

  // A's conversation, with its compose box, is there as soon as A clicks, whatever becomes of the direct connection.
  const composeBoxA = pageA.getByPlaceholder("Message", { exact: true });
  await expect(composeBoxA).toBeVisible({ timeout: ROOM_PANEL_TIMEOUT_MS });

  // A's first send is what asks B for consent: it joins the DM room, and the join is held open until B decides.
  await composeBoxA.fill(TEST_MESSAGE_TEXT);
  await pageA.getByRole("button", { name: "Send", exact: true }).click();
  await expect(pageB.getByText("wants to message you")).toBeVisible({
    timeout: MESSAGE_RENDER_TIMEOUT_MS,
  });

  // B approves A's message request through the real UI, not a scripted decide() call.
  await pageB.getByRole("button", { name: "Allow" }).click();

  // Exact, because the hub connection's frame log also prints every request it carried, message text included. The proof this flow actually works end to end: B's own RoomPanel renders the message A composed and sent, with no token ever manually copied between the two consoles.
  await expect(pageB.getByText(TEST_MESSAGE_TEXT, { exact: true })).toBeVisible(
    {
      timeout: MESSAGE_RENDER_TIMEOUT_MS,
    },
  );

  // Consent runs in each direction: B's first message asks A to allow messages, and until A does, B is told it is waiting rather than left looking at "Sending".
  const composeBoxB = pageB.getByPlaceholder("Message", { exact: true });
  await composeBoxB.fill(TEST_REPLY_TEXT);
  await pageB.getByRole("button", { name: "Send", exact: true }).click();
  await expect(pageB.getByText(/Waiting for .* to allow messages/)).toBeVisible(
    { timeout: MESSAGE_RENDER_TIMEOUT_MS },
  );
  await expect(pageA.getByText("wants to message you")).toBeVisible({
    timeout: MESSAGE_RENDER_TIMEOUT_MS,
  });

  await pageA.getByRole("button", { name: "Allow" }).click();

  await expect(pageA.getByText(TEST_REPLY_TEXT, { exact: true })).toBeVisible({
    timeout: MESSAGE_RENDER_TIMEOUT_MS,
  });
  await expect(pageB.getByText(/Waiting for .* to allow messages/)).toBeHidden({
    timeout: MESSAGE_RENDER_TIMEOUT_MS,
  });
  return [pageA, pageB];
}
