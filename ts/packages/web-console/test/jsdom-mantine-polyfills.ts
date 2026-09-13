// jsdom implements neither matchMedia nor ResizeObserver -- Mantine's MantineProvider reads the former to detect the OS colour-scheme preference, and its ScrollArea (which Table.ScrollContainer and RoomPanel's own message list both use) reads the latter to decide when scrollbars are needed. Every jsdom+Mantine test suite needs both stubs; shared here once two test files needed the identical setup.

import { vi } from "vitest";

export function matchMediaStub(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn<() => void>(),
    removeListener: vi.fn<() => void>(),
    addEventListener: vi.fn<() => void>(),
    removeEventListener: vi.fn<() => void>(),
    dispatchEvent: vi.fn<() => boolean>(() => true),
  };
}

export class ResizeObserverStub {
  observe(): void {
    // no-op
  }
  unobserve(): void {
    // no-op
  }
  disconnect(): void {
    // no-op
  }
}

export function stubMantineJsdomGlobals(): void {
  vi.stubGlobal("matchMedia", matchMediaStub);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
}
