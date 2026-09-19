#!/usr/bin/env node
// The wire-mesh CLI entrypoint: a self-hostable, no-cloud LAN counterpart to cloudflare-hub, wiring the same shared relay-hub domain logic from wire-mesh-core over a real Node WebSocket + http server instead of a Cloudflare Durable Object. Default bind address is 0.0.0.0, not loopback -- the whole point of this package is LAN reachability, unlike a dev-server tool's usual loopback-only default. The same listener also answers a browser: any non-Upgrade request is served from web-console's built static output (wire-mesh#184), so a self-hosted node has somewhere to point a browser at, not just other wire-mesh peers.

import { readFileSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayHub } from "wire-mesh-core/domain/relay-hub";
import { createNodeWebSocketTransport } from "./adapters/node-websocket-transport.js";
import { resolveConsoleFile } from "./static-console.js";

export function healthResponse(): { ok: true; node: string; roles: string[] } {
  return { ok: true, node: "wire-mesh", roles: ["relay"] };
}

const DEFAULT_BIND_ADDRESS = "0.0.0.0:8787";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HEALTH_PATH = "/health";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Populated by scripts/copy-web-console-dist.mjs, which copies web-console's own dist/ here at build time — absent when running src/server.ts directly (e.g. under vitest), which is why every test injects its own consoleDir via createHttpRequestHandler rather than exercising this constant.
const CONSOLE_DIR = join(__dirname, "web-console");

export function bindAddressFromArgs(argv: readonly string[]): string {
  const flagIndex = argv.indexOf("--bind");
  const value = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  return value ?? DEFAULT_BIND_ADDRESS;
}

export interface TlsFilePaths {
  certPath: string;
  keyPath: string;
}

/** Reads --tls-cert/--tls-key from argv, required together — a self-hosted node answering wss:// (wire-mesh#184, so an https://-served PWA can reach it without mixed-content blocking) needs an operator-supplied certificate; this package generates none of its own, matching the README's security note. Returns undefined when neither flag is given, the existing plain-ws:// default. */
export function tlsFromArgs(argv: readonly string[]): TlsFilePaths | undefined {
  const certIndex = argv.indexOf("--tls-cert");
  const keyIndex = argv.indexOf("--tls-key");
  const certPath = certIndex === -1 ? undefined : argv[certIndex + 1];
  const keyPath = keyIndex === -1 ? undefined : argv[keyIndex + 1];
  if (certPath === undefined && keyPath === undefined) {
    return undefined;
  }
  if (certPath === undefined || keyPath === undefined) {
    throw new Error("--tls-cert and --tls-key must be given together");
  }
  return { certPath, keyPath };
}

/** Builds the listener's onHttpRequest handler: /health answers the same JSON shape healthResponse() returns, everything else resolves against consoleDir via resolveConsoleFile. Takes consoleDir as a parameter, not a module-level constant, so a test can point it at a temp fixture instead of the real build-time CONSOLE_DIR. */
export function createHttpRequestHandler(
  consoleDir: string,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === HEALTH_PATH) {
      response.writeHead(HTTP_OK, { "content-type": "application/json" });
      response.end(JSON.stringify(healthResponse()));
      return;
    }
    const file = resolveConsoleFile(consoleDir, url.pathname);
    if (file) {
      response.writeHead(HTTP_OK, {
        "content-type": file.contentType,
        ...file.headers,
      });
      response.end(file.body);
      return;
    }
    response.writeHead(HTTP_NOT_FOUND).end();
  };
}

// A genuine CLI startup message, not library logging -- isolated in its own function so eslint.config.ts's no-console override can scope narrowly to this file rather than the whole package.
function logStartup(message: string): void {
  console.log(message);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const tlsFiles = tlsFromArgs(argv);
  const tls = tlsFiles
    ? {
        certificatePem: readFileSync(tlsFiles.certPath, "utf-8"),
        privateKeyPem: readFileSync(tlsFiles.keyPath, "utf-8"),
      }
    : undefined;
  const hub = createRelayHub();
  const transport = createNodeWebSocketTransport({
    onHttpRequest: createHttpRequestHandler(CONSOLE_DIR),
    ...(tls ? { tls } : {}),
  });
  const listener = await transport.listen(
    bindAddressFromArgs(argv),
    (connection) => {
      void hub.handleConnection(connection);
    },
  );
  logStartup(
    `wire-mesh listening on ${tls ? "wss" : "ws"}://${listener.address}`,
  );
}

// Only run as a side effect when executed directly (the CLI bin entry) -- never on a plain import, which is how the test suite reaches healthResponse()/bindAddressFromArgs() without binding a real port.
//
// Both sides are compared as resolved real paths. A package manager installs a bin as node_modules/.bin/wire-mesh symlinked at this file, and that is the path argv[1] carries, while Node resolves symlinks before recording import.meta.url -- so comparing the two as written strings never matches when the CLI is invoked the way anyone actually invokes it, and the process would exit 0 having started nothing. fileURLToPath rather than a "file://" prefix for the same class of reason: it undoes the percent-encoding import.meta.url applies to a path containing a space or a hash.
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invokedPath)
) {
  void main();
}
