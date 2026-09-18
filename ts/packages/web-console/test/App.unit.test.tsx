// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import { App } from "../src/App.js";
import type { MessageStore, StoredMessage } from "../src/message-store.js";
import { FakeWebSocket } from "./fake-websocket.js";
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
  discoverLocalNode?: () => Promise<string | undefined>,
): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <App
        identity={fakeIdentity()}
        clock={fixedClock}
        messageStore={fakeMessageStore()}
        {...(discoverLocalNode === undefined ? {} : { discoverLocalNode })}
      />
    </MantineProvider>,
  );
}

function submitConnectForm(): void {
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
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
    renderApp(async () => Promise.resolve("ws://127.0.0.1:8787"));

    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    expect(String(sockets[0]?.url)).toBe("ws://127.0.0.1:8787/");
    await screen.findByText("connecting…");
  });

  it("does not start any connection when no same-device node is discovered", async () => {
    renderApp(async () => Promise.resolve(undefined));

    await vi.waitFor(() => {
      expect(screen.queryByRole("button", { name: "Send ping" })).toBeNull();
    });
    expect(sockets).toHaveLength(0);
  });

  it("does not start a duplicate connection when the form is submitted for the address auto-discovery already connected", async () => {
    renderApp(async () => Promise.resolve("ws://localhost:8787"));

    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    submitConnectForm();

    expect(sockets).toHaveLength(1);
  });
});
