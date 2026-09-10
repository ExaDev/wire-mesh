import { defineConfig } from "vite";

// A plain browser app: no framework plugin, no dev proxy -- the console takes full ws:// URLs and WebSocket connections are not same-origin-restricted, so `vite` (dev) serves the page and the page dials the node directly.
export default defineConfig({
  build: {
    outDir: "dist",
  },
});
