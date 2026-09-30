// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { useIntro } from "../src/hooks/use-intro.js";
import {
  createPreferencesStore,
  type PreferencesStore,
} from "../src/preferences-store.js";

const STORAGE_FAILURE = "the origin's storage quota is exhausted";

function store(
  overrides: Readonly<Partial<PreferencesStore>> = {},
): PreferencesStore {
  return { ...createPreferencesStore(createMemoryStorage()), ...overrides };
}

describe("useIntro", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens on a device that has never dismissed it, with nothing to report", async () => {
    const { result } = renderHook(() => useIntro(store()));

    await waitFor(() => {
      expect(result.current.visible).toBe(true);
    });
    expect(result.current.error).toBeUndefined();
  });

  it("reports why the stored answer could not be read, and stays closed and not ready", async () => {
    const failing = store({
      introDismissed: async () => Promise.reject(new Error(STORAGE_FAILURE)),
    });
    const { result } = renderHook(() => useIntro(failing));

    await waitFor(() => {
      expect(result.current.error).toBe(STORAGE_FAILURE);
    });
    expect(result.current.visible).toBe(false);
    expect(result.current.ready).toBe(false);
  });

  it("reports a dismissal that could not be saved while still closing the intro for this session", async () => {
    const failing = store({
      setIntroDismissed: async () => Promise.reject(new Error(STORAGE_FAILURE)),
    });
    const { result } = renderHook(() => useIntro(failing));
    await waitFor(() => {
      expect(result.current.visible).toBe(true);
    });

    act(() => {
      result.current.dismiss();
    });

    await waitFor(() => {
      expect(result.current.error).toBe(STORAGE_FAILURE);
    });
    expect(result.current.visible).toBe(false);
  });

  it("clears the report once a later save succeeds", async () => {
    let failing = true;
    const flaky = store({
      setIntroDismissed: async () =>
        failing
          ? Promise.reject(new Error(STORAGE_FAILURE))
          : Promise.resolve(),
    });
    const { result } = renderHook(() => useIntro(flaky));
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    act(() => {
      result.current.dismiss();
    });
    await waitFor(() => {
      expect(result.current.error).toBe(STORAGE_FAILURE);
    });

    failing = false;
    act(() => {
      result.current.show();
    });

    await waitFor(() => {
      expect(result.current.error).toBeUndefined();
    });
    expect(result.current.visible).toBe(true);
  });
});
