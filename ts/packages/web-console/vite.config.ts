/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// A plain browser app: no framework plugin, no dev proxy -- the console takes full ws:// URLs and WebSocket connections are not same-origin-restricted, so `vite` (dev) serves the page and the page dials the node directly.
export default defineConfig({
  build: {
    outDir: "dist",
  },
  test: {
    // test/e2e/*.spec.ts matches vitest's own default test-file glob, but those are @playwright/test specs (run via `pnpm test:e2e`, not `pnpm test`) with a fixture-based signature vitest doesn't understand -- exclude the whole directory rather than let vitest try and fail to run them.
    exclude: ["test/e2e/**", "**/node_modules/**"],
    // Per-file environment overrides (main.test.ts opts into jsdom via its own `// @vitest-environment jsdom` docblock) rather than a global switch here: jsdom runs its own separate JS realm, so a Uint8Array built under the default Node environment fails `instanceof` checks against jsdom's own Uint8Array constructor -- confirmed directly, switching this globally broke indexeddb-storage.test.ts and web-crypto-identity.test.ts, neither of which touches the DOM at all.
  },
});
