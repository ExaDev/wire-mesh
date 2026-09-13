// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import { App } from "../src/App.js";
import { FakeWebSocket } from "./fake-websocket.js";

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

// jsdom has no matchMedia implementation at all -- Mantine's own MantineProvider reads it to detect the OS colour-scheme preference, so this test environment needs the standard polyfill every jsdom+Mantine test suite requires (Mantine's own docs recommend the identical shape).
function matchMediaStub(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn<() => void>(),
    removeListener: vi.fn<() => void>(),
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
    dispatchEvent: vi.fn<() => boolean>(() => true),
  };
}

// jsdom also has no ResizeObserver -- Mantine's ScrollArea (which Table.ScrollContainer wraps) observes its own size to decide when scrollbars are needed. This console never needs that behaviour under test, only for it not to throw.
class ResizeObserverStub {
  observe(): void {
    // no-op
  }
  unobserve(): void {
    // no-op
  }
  disconnect(): void {
    // no-op
  }
}

/** Every FakeWebSocket App's own createBrowserTransport() constructs, in construction order -- tracking a `new WebSocket(url)` call site that lives entirely inside the component tree under test, not something the test itself can pass a fake into directly. */
let sockets: FakeWebSocket[] = [];

class TrackedFakeWebSocket extends FakeWebSocket {
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
}

function renderApp(): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <App identity={fakeIdentity()} clock={fixedClock} />
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
    vi.stubGlobal("matchMedia", matchMediaStub);
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
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
});
