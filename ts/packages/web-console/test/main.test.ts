// @vitest-environment jsdom

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./fake-websocket.js";

const CONNECT_FORM_HTML = `
  <form id="connect-form">
    <input id="node-address" type="url" value="ws://localhost:8787" required />
    <button type="submit" id="connect-button">Connect</button>
    <label><input type="checkbox" name="domain" value="core/management" checked /> core/management</label>
  </form>
  <div id="connections"></div>
  <template id="connection-template">
    <section class="connection">
      <header class="connection-header">
        <span class="connection-address mono"></span>
        <button type="button" class="ping-button" disabled>Send ping</button>
        <button type="button" class="close-button">Disconnect</button>
      </header>
      <p class="status connection-status">idle</p>
      <p class="directory-empty">No gossip received yet.</p>
      <table class="directory-table" hidden>
        <tbody class="directory-body"></tbody>
      </table>
      <table class="frame-log-table">
        <tbody class="frame-log"></tbody>
      </table>
    </section>
  </template>
`;

/** Every FakeWebSocket main.ts's own createBrowserTransport() constructs, in construction order -- tracking a `new WebSocket(url)` call site that lives entirely inside the module under test, not something the test itself can pass a fake into directly. */
let sockets: FakeWebSocket[] = [];

class TrackedFakeWebSocket extends FakeWebSocket {
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
}

function submitConnectForm(): void {
  const form = document.getElementById("connect-form");
  if (!(form instanceof HTMLFormElement)) throw new Error("missing form");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

/** main.ts always opens the same hardcoded IndexedDB database for its persisted identity, and never closes its own connection -- deleting the whole database would block on that still-open connection, so this clears its one object store's contents instead, via a fresh, short-lived connection of its own. Keeps each test's own dynamic re-import of main.ts (after vi.resetModules()) from reading back a previous test's stored identity envelope. */
async function clearPersistedIdentityDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open("wire-mesh-web-console", 1);
    openRequest.onupgradeneeded = () => {
      if (!openRequest.result.objectStoreNames.contains("kv")) {
        openRequest.result.createObjectStore("kv", { keyPath: "key" });
      }
    };
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      const clearRequest = db
        .transaction("kv", "readwrite")
        .objectStore("kv")
        .clear();
      clearRequest.onsuccess = () => {
        db.close();
        resolve();
      };
      clearRequest.onerror = () => {
        db.close();
        reject(clearRequest.error ?? new Error("failed to clear kv store"));
      };
    };
    openRequest.onerror = () => {
      reject(openRequest.error ?? new Error("failed to open database"));
    };
  });
}

describe("main.ts", () => {
  beforeEach(async () => {
    await clearPersistedIdentityDatabase();
    document.body.innerHTML = CONNECT_FORM_HTML;
    sockets = [];
    vi.stubGlobal("WebSocket", TrackedFakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("renders a connecting status line for the panel once the connect form is submitted", async () => {
    await import("../src/main.ts");

    submitConnectForm();
    await vi.waitFor(() => {
      const status = document.querySelector(".connection-status");
      expect(status?.textContent).toBe("connecting…");
    });
  });

  it("renders connected once the socket opens, and enables the ping button", async () => {
    await import("../src/main.ts");

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    sockets[0]?.emitOpen();

    await vi.waitFor(() => {
      const status = document.querySelector(".connection-status");
      expect(status?.textContent).toContain("connected");
    });
    const pingButton = document.querySelector(".ping-button");
    expect(pingButton).toBeInstanceOf(HTMLButtonElement);
    expect((pingButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("removes the panel when its close button is clicked", async () => {
    await import("../src/main.ts");

    submitConnectForm();
    await vi.waitFor(() => {
      expect(document.querySelector(".connection")).not.toBeNull();
    });

    const closeButton = document.querySelector(".close-button");
    if (!(closeButton instanceof HTMLButtonElement)) {
      throw new Error("missing close button");
    }
    closeButton.click();

    expect(document.querySelector(".connection")).toBeNull();
  });

  it("does not start a second connection attempt for an address that already has one live", async () => {
    await import("../src/main.ts");

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    submitConnectForm();

    expect(sockets).toHaveLength(1);
  });
});
