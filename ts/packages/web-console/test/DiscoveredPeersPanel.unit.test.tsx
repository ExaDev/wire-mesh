// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiscoveredPeersPanel } from "../src/components/DiscoveredPeersPanel.js";
import { deviceIdFromFillHex } from "./hex.js";
import { WithNames } from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const DEVICE_ID_HEX_LENGTH = 64;
const CLAIMED_HEX = "cd".repeat(DEVICE_ID_HEX_LENGTH / 2);

function renderPanel(claimedDevice: string | undefined): void {
  render(
    <WithNames>
      <DiscoveredPeersPanel
        peers={[
          {
            key: "k",
            device: deviceIdFromFillHex("ab"),
            addresses: ["192.0.2.9:4433"],
            via: { address: "ws://hub.example:8787", claimedDevice },
          },
        ]}
        onConnect={() => undefined}
        onDismiss={() => undefined}
      />
    </WithNames>,
  );
}

describe("DiscoveredPeersPanel", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("presents the device a connection was reached as as a claim, beside its address", () => {
    renderPanel(CLAIMED_HEX);

    expect(screen.getByText("claimed to be")).toBeInTheDocument();
    expect(screen.getByText("over ws://hub.example:8787")).toBeInTheDocument();
  });

  it("makes no claim for a connection that was dialled by address", () => {
    renderPanel(undefined);

    expect(screen.queryByText("claimed to be")).not.toBeInTheDocument();
    expect(screen.getByText("over ws://hub.example:8787")).toBeInTheDocument();
  });
});
