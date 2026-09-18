#!/usr/bin/env node
// Copies web-console's already-built static output into this package's own dist/web-console, run as the second step of package.json's `_build` script (tsdown, then this). web-console is `private: true` and never published to npm, so a runtime import of it would only ever resolve inside this monorepo — copying its build output here instead bakes the console into whatever wire-mesh-node itself ships (wire-mesh#184), the same way agent-comms bundles its own frontend directly alongside its server code, rather than depending on the workspace package still being present at install time. static-console.ts resolves requests against dist/web-console at runtime.

import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const source = join(packageRoot, "../web-console/dist");
const destination = join(packageRoot, "dist/web-console");

cpSync(source, destination, { recursive: true });
