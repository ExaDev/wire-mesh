// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { usePeerNames } from "../src/hooks/use-peer-names.js";
import type { PeerNames } from "../src/hooks/use-peer-names.js";
import type { NameStore } from "../src/name-store.js";
import { WithNames, memoryNameStore } from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const DEVICE_ID_BYTES = 32;
const DEVICE_HEX = "ab".repeat(DEVICE_ID_BYTES);
const SLOW_WRITE_MS = 30;
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

  it("applies overlapping renames in the order they were made, whatever order the storage answers in", async () => {
    const inner = memoryNameStore();
    // The first write is slow, so an unserialised second rename would finish first and the first one would then land last and win.
    let writes = 0;
    const store: NameStore = {
      ...inner,
      setPetname: async (deviceHex, name) => {
        writes += 1;
        if (writes === 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, SLOW_WRITE_MS);
          });
        }
        await inner.setPetname(deviceHex, name);
      },
    };
    let names: PeerNames | undefined;
    function Capture(): null {
      names = usePeerNames();
      return null;
    }
    render(
      <WithNames store={store}>
        <Capture />
      </WithNames>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      const first = names?.rename(DEVICE_HEX, "First");
      const second = names?.rename(DEVICE_HEX, "Second");
      await Promise.all([first, second]);
    });

    expect(names?.petnameOf(DEVICE_HEX)).toBe("Second");
  });
});
