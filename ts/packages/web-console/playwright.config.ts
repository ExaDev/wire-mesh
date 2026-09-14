import { defineConfig } from "@playwright/test";

// A fixed, dedicated port pair for the e2e run (never the dev-time 8787/5173 pair) so a developer's own `pnpm dev` session never collides with CI or a concurrent local test run.
export const RELAY_PORT = 8790;
export const VITE_PORT = 8798;
export const RELAY_ADDRESS = `ws://127.0.0.1:${String(RELAY_PORT)}`;
const RELAY_HEALTH_URL = `http://127.0.0.1:${String(RELAY_PORT)}/`;
const HARNESS_URL = `http://localhost:${String(VITE_PORT)}/live-check/harness.html`;

// wire-mesh-node is this package's own sibling; nothing in this workspace declares it as an npm dependency (it isn't one -- web-console never imports it), so turbo's own task graph has no reason to build it before this test runs. CI builds it explicitly as a prerequisite step; a local run needs `pnpm --filter wire-mesh-node build` done at least once too.
const nodePackageDist = new URL("../node/dist/server.mjs", import.meta.url)
  .pathname;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  fullyParallel: false,
  // Every spec file in this directory shares the one relay-hub process started below (a deliberate CI-cost optimisation, not a simulation of unrelated concurrent users) -- webrtc.spec.ts and room-messaging.spec.ts each gossip their own devices onto it. relay-hub now forwards and catches up gossip between every currently-connected client (wire-mesh#110), so two spec files running in separate workers at once would see each other's devices too, breaking room-messaging.spec.ts's own "exactly one other Message button" assumption. `fullyParallel: false` alone only serialises tests *within* one file; `workers: 1` is what actually keeps different spec files from running against the shared hub at the same time.
  workers: 1,
  retries: 0,
  reporter: "list",
  webServer: [
    {
      command: `node ${nodePackageDist} --bind 127.0.0.1:${String(RELAY_PORT)}`,
      url: RELAY_HEALTH_URL,
      reuseExistingServer: process.env.CI === undefined,
      timeout: 10_000,
    },
    {
      command: `npx vite --port ${String(VITE_PORT)} --strictPort`,
      url: HARNESS_URL,
      reuseExistingServer: process.env.CI === undefined,
      timeout: 20_000,
    },
  ],
  use: {
    // Chrome's default mDNS candidate obfuscation replaces a host candidate's real local IP with a random .local hostname (a privacy feature), which never resolves between two independent Chromium contexts on the same machine without real multicast DNS -- disabling it is the standard fix for automated same-machine WebRTC testing. --allow-loopback-in-peer-connection additionally lets ICE use 127.0.0.1 as a host candidate (normally excluded as meaningless across a real network, but exactly what two PeerConnections on the very same machine need).
    launchOptions: {
      args: [
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        "--allow-loopback-in-peer-connection",
      ],
    },
  },
});

export { HARNESS_URL };
