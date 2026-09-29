import { defineConfig } from "@playwright/test";

// The spec run inside each browser container of test/e2e-containers/compose.yaml. No web server is started: the hub is a container of its own and serves the console. Chrome's default candidate handling is left alone (no flag hides or reveals local addresses), which is what a device on a real network runs with. The hub serves https with a certificate made for the run, so the browsers accept it.
export default defineConfig({
  testDir: "./test/e2e-containers",
  // Outside the mounted workspace, so a run leaves nothing behind in it.
  outputDir: "/tmp/test-results",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    // The hub's certificate is made for this run and signed by nothing the browser knows.
    ignoreHTTPSErrors: true,
  },
});
