import { describe, expect, it } from "vitest";
import { pwaManifest } from "../src/pwa-manifest.js";

const REQUIRED_INSTALLABLE_ICON_SIZES = ["192x192", "512x512"];

describe("pwaManifest", () => {
  it("declares a standalone display mode, matching an installed app rather than a browser tab", () => {
    expect(pwaManifest.display).toBe("standalone");
  });

  it("scopes start_url and scope relatively, so an install from any static origin resolves against its own location", () => {
    expect(pwaManifest.start_url).toBe(".");
    expect(pwaManifest.scope).toBe(".");
  });

  it("declares an icon for every size Chromium's installability check requires", () => {
    const declaredSizes = new Set(
      (pwaManifest.icons ?? []).map((icon) => icon.sizes),
    );
    for (const size of REQUIRED_INSTALLABLE_ICON_SIZES) {
      expect(declaredSizes.has(size)).toBe(true);
    }
  });

  it("gives every icon a real src, an SVG type, and an explicit purpose", () => {
    for (const icon of pwaManifest.icons ?? []) {
      expect(icon.src.length).toBeGreaterThan(0);
      expect(icon.type).toBe("image/svg+xml");
      expect(icon.purpose).toBe("any");
    }
  });
});
