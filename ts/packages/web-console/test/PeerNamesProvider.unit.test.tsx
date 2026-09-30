// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { NameStore } from "../src/name-store.js";
import { WithNames, memoryNameStore } from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const STORAGE_FAILURE = "the origin's storage quota is exhausted";

describe("PeerNamesProvider", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the reason when the saved names cannot be read", async () => {
    const store: NameStore = {
      ...memoryNameStore(),
      petnames: async () => Promise.reject(new Error(STORAGE_FAILURE)),
    };

    render(
      <WithNames store={store}>
        <p>child</p>
      </WithNames>,
    );

    expect(await screen.findByText(STORAGE_FAILURE)).toBeInTheDocument();
    expect(screen.getByText("child")).toBeInTheDocument();
  });
});
