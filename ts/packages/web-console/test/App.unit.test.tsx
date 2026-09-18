// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { GossipFrame } from "wire-mesh-core/generated/protocol";
import { messageFromFrame } from "wire-mesh-core/adapters/frame-codec";
import { App } from "../src/App.js";
import type { MessageStore, StoredMessage } from "../src/message-store.js";
import { FakeWebSocket } from "./fake-websocket.js";
import { deviceIdFromFillHex } from "./hex.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const DEVICE_ID_BYTE_LENGTH = 32;

function fakeIdentity(): IdentityPort {
  return {
    deviceId: new Uint8Array(DEVICE_ID_BYTE_LENGTH),
    identityKey: { alg: -7, "public-key": new Uint8Array(0) },
    sign: async () => Promise.resolve(new Uint8Array(0)),
    verify: async () => Promise.resolve(true),
    deriveDeviceId: async () =>
      Promise.resolve(new Uint8Array(DEVICE_ID_BYTE_LENGTH)),
  };
}

const fixedClock: Clock = { now: () => 0 };

function fakeMessageStore(): MessageStore {
  const stored = new Map<string, StoredMessage[]>();
  return {
    async append(roomPath, message): Promise<void> {
      const existing = stored.get(roomPath) ?? [];
      stored.set(roomPath, [...existing, message]);
      return Promise.resolve();
    },
    async list(roomPath): Promise<StoredMessage[]> {
      return Promise.resolve(stored.get(roomPath) ?? []);
    },
  };
}

/** Every FakeWebSocket App's own createBrowserTransport() constructs, in construction order -- tracking a `new WebSocket(url)` call site that lives entirely inside the component tree under test, not something the test itself can pass a fake into directly. */
let sockets: FakeWebSocket[] = [];

class TrackedFakeWebSocket extends FakeWebSocket {
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
}

function renderApp(
  options: Readonly<{
    discoverLocalNode?: () => Promise<string | undefined>;
    defaultAddress?: string;
  }> = {},
): ReturnType<typeof render> {
  const { discoverLocalNode, defaultAddress } = options;
  return render(
    <MantineProvider>
      <App
        identity={fakeIdentity()}
        clock={fixedClock}
        messageStore={fakeMessageStore()}
        {...(discoverLocalNode === undefined ? {} : { discoverLocalNode })}
        {...(defaultAddress === undefined ? {} : { defaultAddress })}
      />
    </MantineProvider>,
  );
}

function submitConnectForm(): void {
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

const gossipedDevice = deviceIdFromFillHex("22");
const gossipedDeviceHex = "22".repeat(gossipedDevice.length);
const GOSSIPED_ADDRESS = "203.0.113.5:4433";

function gossipFrameFor(
  device: Uint8Array<ArrayBuffer>,
  addresses: readonly string[],
): GossipFrame {
  return {
    type: "gossip",
    peers: [{ device, addresses: [...addresses], "snapshot-seconds": 0 }],
  };
}

/** messageFromFrame's own Uint8Array may be a view into a larger backing buffer -- slicing to its own byteOffset/byteLength before handing it to emitMessage is what every other adapter test here already does (see websocket-transport.integration.test.ts's identical helper), since FakeWebSocket.emitMessage takes the raw buffer, not a view onto it. */
function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** The discovered-peer table row for a given device within an already-confirmed-present discovered-peers panel -- scoped lookup so its own "Connect" button can be found distinctly from both the connect form's identically-labelled submit button and the identical device hex rendered elsewhere (a device's own hex also renders inside its originating ConnectionPanel's unrelated "Peer directory" table). Callers must await screen.findByTestId("discovered-peers") first: the panel itself never mounts at all while no peer is pending, so this cannot also do that initial wait. */
function discoveredRow(deviceHex: string): HTMLElement {
  const row = within(screen.getByTestId("discovered-peers"))
    .getByText(deviceHex)
    .closest("tr");
  if (row === null) {
    throw new Error(`expected a table row for device ${deviceHex}`);
  }
  return row;
}

describe("App", () => {
  beforeEach(() => {
    sockets = [];
    vi.stubGlobal("WebSocket", TrackedFakeWebSocket);
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a connecting status line for the panel once the connect form is submitted", async () => {
    renderApp();

    submitConnectForm();

    await screen.findByText("connecting…");
  });

  it("renders connected once the socket opens, and enables the ping button", async () => {
    renderApp();

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    sockets[0]?.emitOpen();

    const status = await screen.findByText(/^connected/);
    expect(status).toBeInTheDocument();
    const pingButton = await screen.findByRole("button", {
      name: "Send ping",
    });
    expect(pingButton).toBeEnabled();
  });

  it("removes the panel when its close button is clicked", async () => {
    renderApp();

    submitConnectForm();
    await screen.findByText("connecting…");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(screen.queryByText(/connecting|connected|closed/)).toBeNull();
  });

  it("does not start a second connection attempt for an address that already has one live", async () => {
    renderApp();

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    submitConnectForm();

    expect(sockets).toHaveLength(1);
  });

  it("auto-connects to a same-device node discovered on mount, with no form submission", async () => {
    renderApp({
      discoverLocalNode: async () => Promise.resolve("ws://127.0.0.1:8787"),
    });

    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    expect(String(sockets[0]?.url)).toBe("ws://127.0.0.1:8787/");
    await screen.findByText("connecting…");
  });

  it("does not start any connection when no same-device node is discovered", async () => {
    renderApp({ discoverLocalNode: async () => Promise.resolve(undefined) });

    await vi.waitFor(() => {
      expect(screen.queryByRole("button", { name: "Send ping" })).toBeNull();
    });
    expect(sockets).toHaveLength(0);
  });

  it("does not start a duplicate connection when the form is submitted for the address auto-discovery already connected", async () => {
    renderApp({
      discoverLocalNode: async () => Promise.resolve("ws://localhost:8787"),
    });

    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    submitConnectForm();

    expect(sockets).toHaveLength(1);
  });

  it("seeds the Node field from the defaultAddress prop, so a build served from a hub's own origin points at it without the operator typing anything", () => {
    renderApp({ defaultAddress: "wss://mesh.exadev.io" });

    expect(screen.getByLabelText(/^Node/)).toHaveValue("wss://mesh.exadev.io");
  });

  it("surfaces a gossiped peer's address as a discovered peer, and dials it once the user clicks Connect", async () => {
    renderApp();

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const rootSocket = sockets[0];
    if (rootSocket === undefined) {
      throw new Error("expected the root socket to exist");
    }
    rootSocket.emitOpen();
    // wrapWebSocket only registers its own "message" listener once createBrowserTransport's own open-event promise resolves, a microtask after emitOpen() -- waiting for the connected status line proves that listener is registered before pushing the gossip frame below, rather than racing it.
    await screen.findByText(/^connected/);
    rootSocket.emitMessage(
      arrayBuffer(
        messageFromFrame(gossipFrameFor(gossipedDevice, [GOSSIPED_ADDRESS])),
      ),
    );

    const panel = await screen.findByTestId("discovered-peers");
    expect(within(panel).getByText(gossipedDeviceHex)).toBeInTheDocument();
    expect(within(panel).getByText(GOSSIPED_ADDRESS)).toBeInTheDocument();

    fireEvent.click(
      within(discoveredRow(gossipedDeviceHex)).getByRole("button", {
        name: "Connect",
      }),
    );
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    // createBrowserTransport passes a parsed URL object (not a bare string) to `new WebSocket(...)`, so FakeWebSocket's own url field round-trips through URL's own normalization (a trailing "/" with no path) -- String(...) is what a real WebSocket's own .url getter would also report.
    expect(String(sockets[1]?.url)).toBe(`ws://${GOSSIPED_ADDRESS}/`);
    expect(screen.queryByTestId("discovered-peers")).toBeNull();
  });

  it("dismissing a discovered peer removes it without dialling", async () => {
    renderApp();

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const rootSocket = sockets[0];
    if (rootSocket === undefined) {
      throw new Error("expected the root socket to exist");
    }
    rootSocket.emitOpen();
    await screen.findByText(/^connected/);
    rootSocket.emitMessage(
      arrayBuffer(
        messageFromFrame(gossipFrameFor(gossipedDevice, [GOSSIPED_ADDRESS])),
      ),
    );

    await screen.findByTestId("discovered-peers");

    fireEvent.click(
      within(discoveredRow(gossipedDeviceHex)).getByRole("button", {
        name: "Dismiss",
      }),
    );

    expect(screen.queryByTestId("discovered-peers")).toBeNull();
    expect(sockets).toHaveLength(1);
  });
});
