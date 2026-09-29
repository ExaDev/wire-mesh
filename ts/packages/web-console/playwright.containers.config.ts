import { defineConfig } from "@playwright/test";

// The spec run inside each browser container of test/e2e-containers/compose.yaml. No web server is started: the hub is a container of its own and serves the console. Chrome's default candidate handling is left alone (no flag hides or reveals local addresses), which is what a device on a real network runs with.
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
    launchOptions: {
      // The console is served over plain http from a container name, which is not a secure context, and it needs Web Crypto. Treating this one origin as secure is the whole of what this flag does.
      args: [
        `--unsafely-treat-insecure-origin-as-secure=${process.env.HUB_ORIGIN ?? ""}`,
      ],
    },
  },
});
