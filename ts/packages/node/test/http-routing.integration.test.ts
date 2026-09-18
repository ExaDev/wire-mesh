// A real http.Server wrapping createHttpRequestHandler's own output, exercised with real fetch() calls — proves the /health-vs-console-vs-404 routing server.ts wires into the listener, without needing a real build (dist/web-console only exists after tsdown + the copy script run, so this test injects its own temp consoleDir instead of the module's build-time CONSOLE_DIR).

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpRequestHandler, healthResponse } from "../src/server.js";

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

describe("createHttpRequestHandler", () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wire-mesh-node-http-test-"));
    writeFileSync(join(dir, "index.html"), "<html>console</html>");

    server = createServer(createHttpRequestHandler(dir));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo from a listening http.Server");
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers /health with the same JSON shape healthResponse() returns", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(HTTP_OK);
    expect(await response.json()).toEqual(healthResponse());
  });

  it("serves the console's index.html for the root path", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(HTTP_OK);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(await response.text()).toBe("<html>console</html>");
  });

  it("falls back to index.html for a client-side route with no matching file", async () => {
    const response = await fetch(`${baseUrl}/room/general`);
    expect(response.status).toBe(HTTP_OK);
    expect(await response.text()).toBe("<html>console</html>");
  });

  it("404s a path with an extension and no matching file", async () => {
    const response = await fetch(`${baseUrl}/assets/missing.js`);
    expect(response.status).toBe(HTTP_NOT_FOUND);
  });
});
