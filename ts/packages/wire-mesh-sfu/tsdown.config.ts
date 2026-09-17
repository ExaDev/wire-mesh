import { defineConfig } from "tsdown";

// Every real module gets its own build entry rather than a re-exporting index.ts: the barrel-policy lint rule requires importing straight from the module that owns each export.
export default defineConfig({
  entry: [
    "src/domain/media-backend.ts",
    "src/domain/sfu-session.ts",
    "src/adapters/sdp-bridge.ts",
    "src/adapters/mediasoup-media-backend.ts",
    "src/server.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  exports: true,
  attw: { profile: "node16" },
  clean: true,
});
