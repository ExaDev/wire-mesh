// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PwaUpdatePrompt } from "../src/components/PwaUpdatePrompt.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const updateServiceWorker = vi.fn();
const setOfflineReady = vi.fn();
const setNeedRefresh = vi.fn();

let offlineReady = false;
let needRefresh = false;

// virtual:pwa-register/react only resolves under a Vite-powered runtime with the VitePWA plugin active. Mocking the specifier directly, rather than relying on that resolution, is what lets this test control offlineReady/needRefresh independently of real service-worker registration.
vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: () => ({
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  }),
}));

function renderPrompt(): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <PwaUpdatePrompt />
    </MantineProvider>,
  );
}

describe("PwaUpdatePrompt", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    offlineReady = false;
    needRefresh = false;
    updateServiceWorker.mockClear();
    setOfflineReady.mockClear();
    setNeedRefresh.mockClear();
  });

  it("renders nothing until the service worker reports offline-ready or an update", () => {
    renderPrompt();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a ready-to-work-offline notification once the shell is cached", () => {
    offlineReady = true;
    renderPrompt();

    expect(screen.getByText("Ready to work offline")).toBeInTheDocument();
  });

  it("shows a reload button once a new build is waiting, and triggers the update on click", () => {
    needRefresh = true;
    renderPrompt();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("clears both flags when the notification is closed", () => {
    offlineReady = true;
    renderPrompt();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(setOfflineReady).toHaveBeenCalledWith(false);
    expect(setNeedRefresh).toHaveBeenCalledWith(false);
  });
});
