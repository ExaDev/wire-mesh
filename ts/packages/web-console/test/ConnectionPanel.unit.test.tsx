// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  createMeshSession,
  type MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import type { Transport } from "wire-mesh-core/ports/transport";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { WithNames } from "./names-harness.js";
import { ConnectionPanel } from "../src/components/ConnectionPanel.js";
import type { PermissionQuerier } from "../src/local-network.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const PUBLIC_PAGE = "mesh.exadev.io";
const LOCAL_ADDRESS = "https://192.168.1.228:4433#sha256=ab";
const RECONNECT_ATTEMPTS = 5;
/** Long enough that the panel is still reconnecting, not closed, when the assertions run. */
const RECONNECT_DELAY_MS = 60_000;

/** A real session whose transport never connects, so it reports reconnecting as soon as it is asked to connect. */
async function failingSession(): Promise<Readonly<MeshSession>> {
  const transport: Transport = {
    connect: async () => Promise.reject(new Error("Opening handshake failed.")),
    listen: async () => Promise.reject(new Error("a client does not listen")),
  };
  const session = createMeshSession(
    transport,
    await createWebCryptoIdentity(),
    { now: () => 0 },
    { maxAttempts: RECONNECT_ATTEMPTS, delayMs: () => RECONNECT_DELAY_MS },
  );
  void session
    .connect(LOCAL_ADDRESS, ["core/management"])
    .catch(() => undefined);
  return session;
}

async function renderPanel(
  permissions: PermissionQuerier | undefined,
  pageHost = PUBLIC_PAGE,
): Promise<void> {
  const session = await failingSession();
  render(
    <WithNames>
      <ConnectionPanel
        address={LOCAL_ADDRESS}
        session={session}
        onClose={() => undefined}
        onMessagePeer={() => undefined}
        pageHost={pageHost}
        permissions={permissions}
      />
    </WithNames>,
  );
}

function permissionAt(state: string): PermissionQuerier {
  return { query: async () => Promise.resolve({ state }) };
}

describe("ConnectionPanel local network explanation", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says why a connection to a local address failed when the browser denied local network access", async () => {
    await renderPanel(permissionAt("denied"));
    expect(
      await screen.findByText(/Allow "Local network access"/),
    ).toBeVisible();
  });

  it("says nothing when the permission was not denied", async () => {
    await renderPanel(permissionAt("granted"));
    await screen.findByText(/reconnecting/);
    await waitFor(() => {
      expect(screen.queryByText(/Local network access/)).toBeNull();
    });
  });

  it("says nothing when the page is itself on the local network", async () => {
    await renderPanel(permissionAt("denied"), "localhost");
    await screen.findByText(/reconnecting/);
    expect(screen.queryByText(/Local network access/)).toBeNull();
  });
});
