#!/usr/bin/env node
// The wire-mesh CLI entrypoint: a self-hostable, no-cloud LAN counterpart to cloudflare-hub, wiring the same shared relay-hub domain logic from wire-mesh-core over a real Node WebSocket + http server instead of a Cloudflare Durable Object. Default bind address (DEFAULT_BIND_ADDRESS in cli-options.ts) is 0.0.0.0, not loopback: the whole point of this package is LAN reachability, unlike a dev-server tool's usual loopback-only default. The same listener also answers a browser: any non-Upgrade request is served from web-console's built static output (wire-mesh#184), so a self-hosted node has somewhere to point a browser at, not just other wire-mesh peers.

import { readFileSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayHub } from "wire-mesh-core/domain/relay-hub";
import { createNodeWebSocketTransport } from "./adapters/node-websocket-transport.js";
import { CliUsageError, helpText, parseCliArguments } from "./cli-options.js";
import { resolveConsoleFile } from "./static-console.js";

export function healthResponse(): { ok: true; node: string; roles: string[] } {
  return { ok: true, node: "wire-mesh", roles: ["relay"] };
}

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HEALTH_PATH = "/health";
// Exit codes: 1 for a failure after the arguments were accepted (an unreadable TLS file, a port already in use), 2 for arguments the CLI rejects, the conventional code for a usage error.
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const __dirname = dirname(fileURLToPath(import.meta.url));
// Populated by scripts/copy-web-console-dist.mjs, which copies web-console's own dist/ here at build time — absent when running src/server.ts directly (e.g. under vitest), which is why every test injects its own consoleDir via createHttpRequestHandler rather than exercising this constant.
const CONSOLE_DIR = join(__dirname, "web-console");

// The package's own manifest, read when asked rather than baked in at build time: the release run builds before it bumps the version, so a build-time copy would report the previous release. Resolved from import.meta.url, which Node records with symlinks already resolved, so it holds when the bin is run through an install symlink; the manifest sits one directory above this module in the source tree and in the published dist alike.
const PACKAGE_MANIFEST_URL = new URL("../package.json", import.meta.url);

function readPackageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(PACKAGE_MANIFEST_URL, "utf-8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(
      `no string "version" in ${fileURLToPath(PACKAGE_MANIFEST_URL)}`,
    );
  }
  return manifest.version;
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

// Genuine CLI output (startup message, --help, --version, error report), not library logging, isolated in these two functions so eslint.config.ts's no-console override can scope narrowly to this file rather than the whole package.
function logOutput(message: string): void {
  console.log(message);
}

function logError(message: string): void {
  console.error(message);
}

async function main(argv: readonly string[]): Promise<void> {
  const command = parseCliArguments(argv);
  if (command.kind === "help") {
    logOutput(helpText());
    return;
  }
  if (command.kind === "version") {
    logOutput(readPackageVersion());
    return;
  }

  const tls = command.tls
    ? {
        certificatePem: readFileSync(command.tls.certPath, "utf-8"),
        privateKeyPem: readFileSync(command.tls.keyPath, "utf-8"),
      }
    : undefined;
  const hub = createRelayHub();
  const transport = createNodeWebSocketTransport({
    onHttpRequest: createHttpRequestHandler(CONSOLE_DIR),
    ...(tls ? { tls } : {}),
  });
  const listener = await transport.listen(command.bindAddress, (connection) => {
    void hub.handleConnection(connection);
  });
  logOutput(
    `wire-mesh listening on ${tls ? "wss" : "ws"}://${listener.address}`,
  );
}

/** Runs the CLI and turns a failure into a one-line message on stderr and a non-zero exit code, instead of an unhandled rejection's stack trace. */
async function run(argv: readonly string[]): Promise<void> {
  try {
    await main(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`wire-mesh: ${message}`);
    if (error instanceof CliUsageError) {
      logError("Run wire-mesh --help for usage.");
      process.exitCode = EXIT_USAGE;
    } else {
      process.exitCode = EXIT_FAILURE;
    }
  }
}

// Only run as a side effect when executed directly (the CLI bin entry), never on a plain import, which is how the test suite reaches healthResponse() without binding a real port.
//
// Both sides are compared as resolved real paths. A package manager installs a bin as node_modules/.bin/wire-mesh symlinked at this file, and that is the path argv[1] carries, while Node resolves symlinks before recording import.meta.url, so comparing the two as written strings never matches when the CLI is invoked the way anyone actually invokes it, and the process would exit 0 having started nothing. fileURLToPath rather than a "file://" prefix for the same class of reason: it undoes the percent-encoding import.meta.url applies to a path containing a space or a hash.
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invokedPath)
) {
  void run(process.argv.slice(2));
}
