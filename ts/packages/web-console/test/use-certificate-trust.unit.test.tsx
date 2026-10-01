// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import {
  formatPinnedAddress,
  parsePinnedAddress,
} from "wire-mesh-core/domain/pinned-address";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import type { Clock } from "wire-mesh-core/ports/clock";
import {
  createCertificateMemory,
  type CertificateMemory,
} from "../src/certificate-memory.js";
import { useCertificateTrust } from "../src/hooks/use-certificate-trust.js";
import { bytesFromHex } from "./hex.js";

const NODE = "192.0.2.5:4433";
const CLOCK: Clock = { now: () => 0 };
const SHA256_HEX_LENGTH = 64;
const hashHex = (digit: string): string => digit.repeat(SHA256_HEX_LENGTH);
const pinnedTo = (...digits: readonly string[]): string =>
  formatPinnedAddress(
    NODE,
    digits.map((digit) => hashHex(digit)),
  );
const pinsOf = (address: string): string[] =>
  parsePinnedAddress(address).sha256.map((hash) => bytesToHex(hash));

/** A certificate memory that has been told `digits`' certificates for the node, or nothing when none are given. */
async function memoryRemembering(
  ...digits: readonly string[]
): Promise<CertificateMemory> {
  const memory = createCertificateMemory(createMemoryStorage());
  if (digits.length > 0) {
    await memory.remember(
      NODE,
      digits.map((digit) => bytesFromHex(hashHex(digit))),
    );
  }
  return memory;
}

describe("useCertificateTrust", () => {
  afterEach(() => {
    cleanup();
  });

  it("dials an address without pins as it is", async () => {
    const { result } = renderHook(() =>
      useCertificateTrust(
        createCertificateMemory(createMemoryStorage()),
        CLOCK,
      ),
    );

    await expect(result.current.confirmAddress("ws://hub:1")).resolves.toBe(
      "ws://hub:1",
    );
  });

  it("dials a known address with only the presented pins that are remembered", async () => {
    const memory = await memoryRemembering("a");
    const { result } = renderHook(() => useCertificateTrust(memory, CLOCK));

    const dial = await result.current.confirmAddress(pinnedTo("a", "b"));

    expect(dial).toBeDefined();
    expect(pinsOf(dial ?? "")).toEqual([hashHex("a")]);
    expect(result.current.prompts).toEqual([]);
  });

  it("asks once for the same node and certificates requested twice, and dials as presented once trusted", async () => {
    const memory = await memoryRemembering();
    const { result } = renderHook(() => useCertificateTrust(memory, CLOCK));

    const first = result.current.confirmAddress(pinnedTo("a"));
    const second = result.current.confirmAddress(pinnedTo("a"));
    await waitFor(() => {
      expect(result.current.prompts).toHaveLength(1);
    });
    act(() => {
      result.current.prompts[0]?.decide(true);
    });

    await expect(first).resolves.toBe(pinnedTo("a"));
    await expect(second).resolves.toBe(pinnedTo("a"));
    expect(await memory.recall(NODE)).toEqual([bytesFromHex(hashHex("a"))]);
  });

  it("asks separately when the same node presents other certificates", async () => {
    const memory = await memoryRemembering();
    const { result } = renderHook(() => useCertificateTrust(memory, CLOCK));

    void result.current.confirmAddress(pinnedTo("a"));
    void result.current.confirmAddress(pinnedTo("b"));

    await waitFor(() => {
      expect(result.current.prompts).toHaveLength(2);
    });
  });

  it("refuses every pending decision when the console closes", async () => {
    const memory = await memoryRemembering();
    const { result, unmount } = renderHook(() =>
      useCertificateTrust(memory, CLOCK),
    );

    const pending = result.current.confirmAddress(pinnedTo("a"));
    await waitFor(() => {
      expect(result.current.prompts).toHaveLength(1);
    });
    unmount();

    await expect(pending).resolves.toBeUndefined();
    expect(await memory.recall(NODE)).toEqual([]);
  });

  it("keeps a newer prompt for the same question intact when an older one is decided again", async () => {
    const memory = await memoryRemembering();
    const { result, unmount } = renderHook(() =>
      useCertificateTrust(memory, CLOCK),
    );
    const first = result.current.confirmAddress(pinnedTo("a"));
    await waitFor(() => {
      expect(result.current.prompts).toHaveLength(1);
    });
    const older = result.current.prompts[0];
    act(() => {
      older?.decide(false);
    });
    await expect(first).resolves.toBeUndefined();

    const second = result.current.confirmAddress(pinnedTo("a"));
    await waitFor(() => {
      expect(result.current.prompts).toHaveLength(1);
    });
    const newer = result.current.prompts[0];
    act(() => {
      older?.decide(true);
    });
    // A third request still shares the newer prompt instead of raising another.
    const third = result.current.confirmAddress(pinnedTo("a"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.prompts).toEqual([newer]);
    unmount();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
    expect(await memory.recall(NODE)).toEqual([]);
  });
});
