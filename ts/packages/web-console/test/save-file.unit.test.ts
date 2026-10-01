// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTextFile } from "../src/save-file.js";

const BLOB_URL = "blob:test-url";
/** Longer than the delay the module waits before revoking, without restating it. */
const WELL_AFTER_THE_DOWNLOAD_STARTED_MS = 600_000;

describe("saveTextFile", () => {
  const createObjectURL = vi.fn<(blob: Readonly<Blob>) => string>(
    () => BLOB_URL,
  );
  const revokeObjectURL = vi.fn<(url: string) => void>();

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("clicks an anchor that is attached to the document, carrying the filename and the blob URL", () => {
    const seen: { attached: boolean; download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      seen.push({
        attached: this.isConnected,
        download: this.download,
        href: this.href,
      });
    });

    saveTextFile("backup.json", "{}");

    expect(seen).toEqual([
      { attached: true, download: "backup.json", href: BLOB_URL },
    ]);
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("keeps the blob URL alive after the click and revokes it later", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );

    saveTextFile("backup.json", "{}");

    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WELL_AFTER_THE_DOWNLOAD_STARTED_MS);
    expect(revokeObjectURL).toHaveBeenCalledWith(BLOB_URL);
  });
});
