// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PeerLabel } from "../src/components/PeerLabel.js";
import { shortId } from "../src/peer-names.js";
import { WithNames, memoryNameStore } from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const DEVICE_ID_BYTES = 32;
const DEVICE_HEX = "cd".repeat(DEVICE_ID_BYTES);

describe("PeerLabel", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the short id for a peer nothing names", () => {
    render(
      <WithNames>
        <PeerLabel deviceHex={DEVICE_HEX} />
      </WithNames>,
    );

    expect(screen.getByText(shortId(DEVICE_HEX))).toBeInTheDocument();
  });

  it("shows a stored petname in place of the short id", async () => {
    const store = memoryNameStore();
    await store.setPetname(DEVICE_HEX, "Ada");

    render(
      <WithNames store={store}>
        <PeerLabel deviceHex={DEVICE_HEX} />
      </WithNames>,
    );

    await screen.findByText("Ada");
    expect(screen.queryByText(shortId(DEVICE_HEX))).toBeNull();
  });

  it("renames a peer, persists the petname and shows it", async () => {
    const store = memoryNameStore();
    render(
      <WithNames store={store}>
        <PeerLabel deviceHex={DEVICE_HEX} />
      </WithNames>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Rename/ }));
    fireEvent.change(screen.getByLabelText(/^Petname for/), {
      target: { value: "Grace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save petname" }));

    await screen.findByText("Grace");
    expect(await store.petnames()).toEqual(new Map([[DEVICE_HEX, "Grace"]]));
  });

  it("leaves the name unchanged when a rename is cancelled", async () => {
    const store = memoryNameStore();
    render(
      <WithNames store={store}>
        <PeerLabel deviceHex={DEVICE_HEX} />
      </WithNames>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Rename/ }));
    fireEvent.change(screen.getByLabelText(/^Petname for/), {
      target: { value: "Grace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel rename" }));

    expect(screen.getByText(shortId(DEVICE_HEX))).toBeInTheDocument();
    expect(await store.petnames()).toEqual(new Map());
  });

  it("copies the full device-id", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () =>
      Promise.resolve(),
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <WithNames>
        <PeerLabel deviceHex={DEVICE_HEX} />
      </WithNames>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Copy device id/ }));

    expect(writeText).toHaveBeenCalledWith(DEVICE_HEX);
  });
});
