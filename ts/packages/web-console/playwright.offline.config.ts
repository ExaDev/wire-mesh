import { defineConfig } from "@playwright/test";

/**
 * The spec run inside each browser container of test/e2e-containers-offline/compose.yaml. The browser is launched by the spec itself, with a profile directory that survives between the two phases of a run, so the service worker installed in the first is still there in the second.
 */
export default defineConfig({
  testDir: "./test/e2e-containers-offline",
  outputDir: "/tmp/test-results",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
});
