import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConsoleFile } from "../src/static-console.js";

describe("resolveConsoleFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wire-mesh-console-test-"));
    writeFileSync(join(dir, "index.html"), "<html>shell</html>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "console.log('app')");
    writeFileSync(join(dir, "sw.js"), "// service worker");
    writeFileSync(join(dir, "manifest.webmanifest"), "{}");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves index.html for the root path", () => {
    const file = resolveConsoleFile(dir, "/");
    expect(file?.contentType).toBe("text/html; charset=utf-8");
    expect(file?.body.toString()).toBe("<html>shell</html>");
  });

  it("serves a nested asset with its extension's content type", () => {
    const file = resolveConsoleFile(dir, "/assets/app.js");
    expect(file?.contentType).toBe("application/javascript; charset=utf-8");
    expect(file?.body.toString()).toBe("console.log('app')");
  });

  it("serves the web app manifest with its dedicated content type", () => {
    const file = resolveConsoleFile(dir, "/manifest.webmanifest");
    expect(file?.contentType).toBe("application/manifest+json; charset=utf-8");
  });

  it("attaches Service-Worker-Allowed: / to sw.js and nothing else", () => {
    const sw = resolveConsoleFile(dir, "/sw.js");
    expect(sw?.headers).toEqual({ "Service-Worker-Allowed": "/" });
    const app = resolveConsoleFile(dir, "/assets/app.js");
    expect(app?.headers).toBeUndefined();
  });

  it("falls back to index.html for an extension-less path (a client-side route)", () => {
    const file = resolveConsoleFile(dir, "/room/general");
    expect(file?.body.toString()).toBe("<html>shell</html>");
  });

  it("404s a missing file that has an extension", () => {
    expect(resolveConsoleFile(dir, "/assets/missing.js")).toBeUndefined();
  });

  it("refuses to escape consoleDir via a literal traversal path", () => {
    expect(
      resolveConsoleFile(dir, "/../../../../../../etc/passwd"),
    ).toBeUndefined();
  });

  it("refuses to escape consoleDir via a percent-encoded traversal path", () => {
    expect(
      resolveConsoleFile(dir, "/%2e%2e/%2e%2e/%2e%2e/etc/passwd"),
    ).toBeUndefined();
  });

  it("returns undefined for a malformed percent-encoded path rather than throwing", () => {
    expect(resolveConsoleFile(dir, "/%")).toBeUndefined();
  });
});
