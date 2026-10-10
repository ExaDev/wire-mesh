#!/usr/bin/env node
// The wire-mesh CLI entrypoint: a self-hostable, no-cloud LAN counterpart to cloudflare-hub, wiring the same shared relay-hub domain logic from wire-mesh-core over a real Node WebSocket + http server instead of a Cloudflare Durable Object. Default bind address (DEFAULT_BIND_ADDRESS in cli-options.ts) is 0.0.0.0, not loopback: the whole point of this package is LAN reachability, unlike a dev-server tool's usual loopback-only default. The same listener also answers a browser: any non-Upgrade request is served from web-console's built static output (wire-mesh#184), so a self-hosted node has somewhere to point a browser at, not just other wire-mesh peers.

import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayHub } from "wire-mesh-core/domain/relay-hub";
import {
  deriveDeviceId,
  verifyWithPublicKey,
} from "wire-mesh-core/adapters/node-identity";
import { createNodeWebSocketTransport } from "./adapters/node-websocket-transport.js";
import { CliUsageError, helpText, parseCliArguments } from "./cli-options.js";
import { createMailbox } from "wire-mesh-core/domain/hub-mailbox";
import { createNodeFsStorage } from "wire-mesh-core/adapters/node-fs-storage";
import { nodeMailboxLimits } from "./mailbox-limits.js";
import { createWebTransportTransport } from "./adapters/webtransport-transport.js";
import { resolveConsoleFile } from "./static-console.js";

/** What /health says: the relay role always, and the announcer role when the node was given somewhere to hold other devices' logs. */
export function healthResponse(announcer: boolean): {
  ok: true;
  node: string;
  roles: string[];
} {
  return {
    ok: true,
    node: "wire-mesh",
    roles: announcer ? ["relay", "announcer"] : ["relay"],
  };
}

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
/** Owner read, write and search only: the state directory holds private keys. */
const STATE_DIR_MODE = 0o700;

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
  announcer: boolean,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === HEALTH_PATH) {
      response.writeHead(HTTP_OK, { "content-type": "application/json" });
      response.end(JSON.stringify(healthResponse(announcer)));

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
  // Only the verification half of core's Node identity adapter: a gossiped advert is self-certifying (wire-mesh#225), so the hub checks each one against the key the advert itself carries rather than holding a signing identity of its own.
  const hub = createRelayHub({
    identity: { verify: verifyWithPublicKey, deriveDeviceId },
    ...(command.mailboxDir !== undefined
      ? {
          mailbox: createMailbox({
            storage: createNodeFsStorage({ dir: command.mailboxDir }),
            limits: nodeMailboxLimits,
          }),
          onMailboxRefused: ({ reason }) => {
            logError(`wire-mesh: refused a data frame: ${reason}`);
          },
        }
      : {}),
  });
  const transport = createNodeWebSocketTransport({
    onHttpRequest: createHttpRequestHandler(
      CONSOLE_DIR,
      command.mailboxDir !== undefined,
    ),
    ...(tls ? { tls } : {}),
  });
  const listener = await transport.listen(command.bindAddress, (connection) => {
    void hub.handleConnection(connection);
  });
  logOutput(
    `wire-mesh listening on ${tls ? "wss" : "ws"}://${listener.address}`,
  );
  if (command.webTransportAddress !== undefined) {
    // The certificate schedule holds private keys, so the directory is created for this user alone before anything is written to it.
    if (command.stateDir !== undefined) {
      mkdirSync(command.stateDir, { recursive: true, mode: STATE_DIR_MODE });
    }
    const webTransport = await createWebTransportTransport({
      ...(command.certificateLifetimeMs !== undefined
        ? { certificateLifetimeMs: command.certificateLifetimeMs }
        : {}),
      ...(command.stateDir !== undefined
        ? { storage: createNodeFsStorage({ dir: command.stateDir }) }
        : {}),
      onError: (error) => {
        logError(`wire-mesh: WebTransport: ${String(error)}`);
      },
      onCertificateRenewed: (addresses) => {
        logOutput(
          `wire-mesh WebTransport addresses changed: ${addresses.join(" ")}`,
        );
      },
    }).listen(command.webTransportAddress, (connection) => {
      void hub.handleConnection(connection);
    });
    for (const address of webTransport.advertisedAddresses) {
      logOutput(`wire-mesh serving WebTransport at ${address}`);
    }
  }
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

/* Only run as a side effect when executed directly (the CLI bin entry), never on a plain import, which is how the test suite reaches healthResponse() without binding a real port.

   Both sides are compared as resolved real paths. A package manager installs a bin as node_modules/.bin/wire-mesh symlinked at this file, and that is the path argv[1] carries, while Node resolves symlinks before recording import.meta.url, so comparing the two as written strings never matches when the CLI is invoked the way anyone actually invokes it, and the process would exit 0 having started nothing. fileURLToPath rather than a "file://" prefix for the same class of reason: it undoes the percent-encoding import.meta.url applies to a path containing a space or a hash. */
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invokedPath)
) {
  void run(process.argv.slice(2));
}
