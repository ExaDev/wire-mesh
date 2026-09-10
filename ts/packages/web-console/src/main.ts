// The console's DOM wiring: one MeshSession per open connection, rendering each session's SessionEvent into its own status line, peer directory table, and frame log. Kept thin on purpose -- everything with behaviour lives in mesh-session.ts so it can be tested without a browser.

import { createIndexedDbStorage } from "./adapters/indexeddb-storage.js";
import { createPersistedWebCryptoIdentity } from "./adapters/web-crypto-identity.js";
import { createBrowserTransport } from "./adapters/websocket-transport.js";
import { createMeshSession } from "./mesh-session.js";
import type { SessionEvent } from "./mesh-session.js";

// Passing the constructor rather than asserting: T appears in both the parameter and return, and the instanceof check makes the lookup self-verifying at runtime.
function requireElement<E extends HTMLElement>(
  id: string,
  kind: new () => E,
): E {
  const element = document.getElementById(id);
  if (!(element instanceof kind)) {
    throw new Error(`missing element #${id}`);
  }
  return element;
}

/** Same self-verifying lookup as requireElement, scoped to a subtree rather than the whole document -- for querying inside one connection's own cloned template instance. */
function requireChild<E extends HTMLElement>(
  root: ParentNode,
  selector: string,
  kind: new () => E,
): E {
  const element = root.querySelector(selector);
  if (!(element instanceof kind)) {
    throw new Error(`missing element matching ${selector}`);
  }
  return element;
}

const form = requireElement("connect-form", HTMLFormElement);
const addressInput = requireElement("node-address", HTMLInputElement);
const connectionsContainer = requireElement("connections", HTMLDivElement);
const connectionTemplate = requireElement(
  "connection-template",
  HTMLTemplateElement,
);

// One shared identity and clock across every connection this console makes: the device-id must stay stable regardless of how many nodes it talks to, only the per-connection session state differs.
const identity = await createPersistedWebCryptoIdentity(
  await createIndexedDbStorage(),
);
const clock = { now: () => Date.now() };

const HEX_RADIX = 16;

function deviceHex(device: Uint8Array): string {
  let hex = "";
  for (const byte of device) {
    hex += byte.toString(HEX_RADIX).padStart(2, "0");
  }
  return hex;
}

function describeHandshake(event: SessionEvent): string {
  if (event.state.status !== "connected") {
    return "";
  }
  switch (event.state.handshake.status) {
    case "pending":
      return " · handshake pending";
    case "negotiated":
      return ` · v${String(event.state.handshake.version)} · ${event.state.handshake.sharedDomains.join(", ")}`;
    case "unanswered":
      return " · handshake unanswered (relay-only node?)";
    case "rejected":
      return ` · handshake rejected (${event.state.handshake.reason})`;
  }
  return "";
}

interface ConnectionPanel {
  root: HTMLElement;
  statusLine: HTMLParagraphElement;
  directoryEmpty: HTMLParagraphElement;
  directoryTable: HTMLTableElement;
  directoryBody: HTMLTableSectionElement;
  frameLogBody: HTMLTableSectionElement;
  pingButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
}

function createConnectionPanel(address: string): ConnectionPanel {
  const fragment = connectionTemplate.content.cloneNode(true);
  if (!(fragment instanceof DocumentFragment)) {
    throw new Error("connection template did not clone to a DocumentFragment");
  }
  const root = requireChild(fragment, ".connection", HTMLElement);
  requireChild(fragment, ".connection-address", HTMLSpanElement).textContent =
    address;
  const panel: ConnectionPanel = {
    root,
    statusLine: requireChild(
      fragment,
      ".connection-status",
      HTMLParagraphElement,
    ),
    directoryEmpty: requireChild(
      fragment,
      ".directory-empty",
      HTMLParagraphElement,
    ),
    directoryTable: requireChild(
      fragment,
      ".directory-table",
      HTMLTableElement,
    ),
    directoryBody: requireChild(
      fragment,
      ".directory-body",
      HTMLTableSectionElement,
    ),
    frameLogBody: requireChild(fragment, ".frame-log", HTMLTableSectionElement),
    pingButton: requireChild(fragment, ".ping-button", HTMLButtonElement),
    closeButton: requireChild(fragment, ".close-button", HTMLButtonElement),
  };
  connectionsContainer.append(fragment);
  return panel;
}

function render(panel: ConnectionPanel, event: SessionEvent): void {
  const { state } = event;
  panel.statusLine.textContent =
    state.status === "connecting"
      ? "connecting…"
      : state.status === "connected"
        ? `connected${describeHandshake(event)}`
        : state.status === "reconnecting"
          ? `reconnecting (attempt ${String(state.attempt)}, ${state.reason})…`
          : state.status === "closed"
            ? `closed (${state.reason})`
            : "idle";

  panel.pingButton.disabled = state.status !== "connected";
  // The close button is never disabled: a panel in any state (including a dead, closed one) must always be dismissable, since nothing else removes it from the page.

  panel.directoryEmpty.hidden = event.directory.length > 0;
  panel.directoryTable.hidden = event.directory.length === 0;
  panel.directoryBody.replaceChildren(
    ...event.directory.map((entry) => {
      const row = document.createElement("tr");
      const deviceCell = document.createElement("td");
      deviceCell.textContent = deviceHex(entry.device);
      const addressesCell = document.createElement("td");
      addressesCell.textContent = entry.advert.addresses.join(", ");
      const snapshotCell = document.createElement("td");
      snapshotCell.textContent = String(entry.advert["snapshot-seconds"]);
      row.append(deviceCell, addressesCell, snapshotCell);
      return row;
    }),
  );

  panel.frameLogBody.replaceChildren(
    ...event.frameLog.map((entry) => {
      const row = document.createElement("tr");
      const directionCell = document.createElement("td");
      directionCell.textContent = entry.direction;
      const frameCell = document.createElement("td");
      frameCell.textContent = JSON.stringify(
        entry.frame,
        (_key: string, value: unknown): unknown =>
          value instanceof Uint8Array
            ? `<${String(value.byteLength)} bytes>`
            : value,
      );
      row.append(directionCell, frameCell);
      return row;
    }),
  );
  const frameLogTable = panel.frameLogBody.parentElement;
  if (frameLogTable !== null) {
    frameLogTable.scrollTop = frameLogTable.scrollHeight;
  }
}

const sessions = new Map<string, ReturnType<typeof createMeshSession>>();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const address = addressInput.value;
  // Re-submitting an address that already has a live entry is a no-op, mirroring the previous single-session guard's exact refusal to start a second connect attempt over an active one. An entry is removed either by its own panel's close button, or automatically when its connect attempt fails (the same "clear it back out so the address can be retried" behaviour the original single-session code applied by nulling its module-level session) -- so resubmitting the same address after a failure starts a fresh attempt, but resubmitting while still connecting/connected/reconnecting is a no-op rather than a silent replacement.
  if (sessions.has(address)) {
    return;
  }
  const domains = [
    ...form.querySelectorAll<HTMLInputElement>("input[name='domain']:checked"),
  ].map((checkbox) => checkbox.value);

  const panel = createConnectionPanel(address);
  const session = createMeshSession(createBrowserTransport(), identity, clock);
  sessions.set(address, session);

  panel.pingButton.addEventListener("click", () => {
    void session.sendPing().catch((error: unknown) => {
      panel.statusLine.textContent = `send failed: ${error instanceof Error ? error.message : String(error)}`;
    });
  });
  panel.closeButton.addEventListener("click", () => {
    void session.close();
    sessions.delete(address);
    panel.root.remove();
  });

  void (async () => {
    for await (const sessionEvent of session.events) {
      render(panel, sessionEvent);
    }
  })();
  void session.connect(address, domains).catch((error: unknown) => {
    panel.statusLine.textContent = `connect failed: ${error instanceof Error ? error.message : String(error)}`;
    sessions.delete(address);
  });
});
