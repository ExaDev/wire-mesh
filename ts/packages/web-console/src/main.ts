// The console's DOM wiring: one MeshSession per connection attempt, rendering each SessionEvent into the connection status line, the peer directory table, and the frame log. Kept thin on purpose -- everything with behaviour lives in mesh-session.ts so it can be tested without a browser.

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

const form = requireElement("connect-form", HTMLFormElement);
const addressInput = requireElement("node-address", HTMLInputElement);
const connectButton = requireElement("connect-button", HTMLButtonElement);
const pingButton = requireElement("ping-button", HTMLButtonElement);
const closeButton = requireElement("close-button", HTMLButtonElement);
const statusLine = requireElement("connection-status", HTMLParagraphElement);
const directoryEmpty = requireElement("directory-empty", HTMLParagraphElement);
const directoryTable = requireElement("directory-table", HTMLTableElement);
const directoryBody = requireElement("directory-body", HTMLTableSectionElement);
const frameLogBody = requireElement("frame-log", HTMLTableSectionElement);

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

function render(event: SessionEvent): void {
  const { state } = event;
  statusLine.textContent =
    state.status === "idle"
      ? "idle"
      : state.status === "connecting"
        ? `connecting to ${state.address}…`
        : state.status === "connected"
          ? `connected to ${state.address}${describeHandshake(event)}`
          : `closed (${state.reason})`;

  const connected = state.status === "connected";
  pingButton.disabled = !connected;
  closeButton.disabled = !connected;
  connectButton.disabled = connected || state.status === "connecting";
  addressInput.disabled = connected || state.status === "connecting";

  directoryEmpty.hidden = event.directory.length > 0;
  directoryTable.hidden = event.directory.length === 0;
  directoryBody.replaceChildren(
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

  frameLogBody.replaceChildren(
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
  const frameLogTable = frameLogBody.parentElement;
  if (frameLogTable !== null) {
    frameLogTable.scrollTop = frameLogTable.scrollHeight;
  }
}

let session: ReturnType<typeof createMeshSession> | null = null;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (session !== null) {
    return;
  }
  const domains = [
    ...form.querySelectorAll<HTMLInputElement>("input[name='domain']:checked"),
  ].map((checkbox) => checkbox.value);
  session = createMeshSession(createBrowserTransport());
  void (async () => {
    for await (const sessionEvent of session.events) {
      render(sessionEvent);
    }
  })();
  void session.connect(addressInput.value, domains).catch((error: unknown) => {
    statusLine.textContent = `connect failed: ${error instanceof Error ? error.message : String(error)}`;
    session = null;
  });
});

pingButton.addEventListener("click", () => {
  if (session !== null) {
    void session.sendPing().catch((error: unknown) => {
      statusLine.textContent = `send failed: ${error instanceof Error ? error.message : String(error)}`;
    });
  }
});

closeButton.addEventListener("click", () => {
  if (session !== null) {
    void session.close();
    session = null;
    connectButton.disabled = false;
    addressInput.disabled = false;
    pingButton.disabled = true;
    closeButton.disabled = true;
  }
});
