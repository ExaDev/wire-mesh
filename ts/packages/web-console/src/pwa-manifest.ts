import type { ManifestOptions } from "vite-plugin-pwa";

// Deployable from any static origin (see README), so start_url/scope are relative rather than root-absolute: an install served from a subpath still resolves both against its own location.
export const pwaManifest: Partial<ManifestOptions> = {
  name: "wire-mesh console",
  short_name: "wire-mesh",
  description:
    "Browser client for wire-mesh: connect to any node, inspect the peer directory, and message rooms over WebSocket or a negotiated WebRTC data channel.",
  start_url: ".",
  scope: ".",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#1971c2",
  icons: [
    {
      src: "icons/icon-192x192.svg",
      sizes: "192x192",
      type: "image/svg+xml",
      purpose: "any",
    },
    {
      src: "icons/icon-512x512.svg",
      sizes: "512x512",
      type: "image/svg+xml",
      purpose: "any",
    },
  ],
};
