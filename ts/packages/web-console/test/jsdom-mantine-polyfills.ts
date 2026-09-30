// jsdom implements none of matchMedia, ResizeObserver or document.fonts. Mantine's MantineProvider reads matchMedia to detect the OS colour-scheme preference, its ScrollArea (which Table.ScrollContainer and RoomPanel's own message list both use) reads ResizeObserver to decide when scrollbars are needed, and its autosizing Textarea listens to document.fonts. Every jsdom+Mantine test suite needs these stubs; shared here so each does not repeat them.

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

/** jsdom has no `document.fonts`, which Mantine's autosizing Textarea listens to so it can resize once a web font has loaded. */
const fontsStub = {
  addEventListener: vi.fn<() => void>(),
  removeEventListener: vi.fn<() => void>(),
};

export function stubMantineJsdomGlobals(): void {
  vi.stubGlobal("matchMedia", matchMediaStub);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(document, "fonts", {
    value: fontsStub,
    configurable: true,
  });
}
