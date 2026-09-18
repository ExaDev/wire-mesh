// Resolves an HTTP request path to a file under web-console's built static output, copied into dist/web-console alongside dist/server.mjs by scripts/copy-web-console-dist.mjs at build time. Pure path-to-file resolution with no Node HTTP types in its signature, so it is testable against a plain temp directory fixture without a real server or a real build. An extension-less path that doesn't match a real file falls back to index.html, the same client-side-route fallback vite-plugin-pwa's own `navigateFallback: "index.html"` already gives this console for its offline/service-worker case — a browser navigating to a route the SPA itself resolves must still get the app shell, not a 404.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const INDEX_FILE = "index.html";
// The service worker must be allowed to control the whole origin, not just the directory it happens to be served from — vite-plugin-pwa's generated sw.js sits at the console root precisely so this header can say "/", the same header (and the same reason) agent-comms' own web server sets for its own sw.js.
const SERVICE_WORKER_ALLOWED_HEADERS: Readonly<Record<string, string>> = {
  "Service-Worker-Allowed": "/",
};

export interface StaticFile {
  body: Buffer;
  contentType: string;
  headers?: Readonly<Record<string, string>>;
}

/** Resolves `pathname` (a request URL's raw, still percent-encoded path) to a file under `consoleDir`. Returns undefined for a path that decodes to something outside `consoleDir` (a traversal attempt), a malformed percent-encoding, or a real 404 — an extension-bearing path with no matching file. */
export function resolveConsoleFile(
  consoleDir: string,
  pathname: string,
): StaticFile | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  const root = normalize(consoleDir);
  const relative = decoded === "/" ? INDEX_FILE : decoded.replace(/^\/+/, "");
  let filePath = normalize(join(root, relative));
  if (!filePath.startsWith(root + sep) && filePath !== root) {
    return undefined;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    if (extname(decoded) !== "") {
      return undefined;
    }
    filePath = join(root, INDEX_FILE);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return undefined;
    }
  }

  const contentType = CONTENT_TYPES[extname(filePath)] ?? DEFAULT_CONTENT_TYPE;
  const body = readFileSync(filePath);
  return {
    body,
    contentType,
    ...(filePath.endsWith("sw.js")
      ? { headers: SERVICE_WORKER_ALLOWED_HEADERS }
      : {}),
  };
}
