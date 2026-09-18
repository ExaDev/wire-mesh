/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";
import type { AcceptedPlugin } from "postcss";
import postcssPresetMantine from "postcss-preset-mantine";
import postcssSimpleVars from "postcss-simple-vars";
import { pwaManifest } from "./src/pwa-manifest.js";

// Mantine's own breakpoint variables ($mantine-breakpoint-*), consumed by postcss-simple-vars below -- Mantine's own docs recommend a standalone postcss.config file for these, but a single Vite project has no other consumer of this PostCSS pipeline, so it lives here instead of as a second config file.
const MANTINE_BREAKPOINTS = {
  "mantine-breakpoint-xs": "36em",
  "mantine-breakpoint-sm": "48em",
  "mantine-breakpoint-md": "62em",
  "mantine-breakpoint-lg": "75em",
  "mantine-breakpoint-xl": "88em",
};

function isCallable(value: unknown): value is (arg?: unknown) => unknown {
  return typeof value === "function";
}

function isPostcssPlugin(value: unknown): value is AcceptedPlugin {
  return typeof value === "object" && value !== null;
}

/** Calls an untyped PostCSS plugin factory and narrows its result to AcceptedPlugin -- postcss-preset-mantine ships a bare `declare module "postcss-preset-mantine";` (TypeScript's own "shorthand ambient module" form, which makes every export `any` and can't be overridden by a project-local declaration for the same specifier), and postcss-simple-vars's own real .d.ts declares an explicit `any` return. Routing both through the same `unknown`-typed parameter and a pair of type guards keeps that `any` from reaching any typed assignment or call site, without a type assertion (this project's own consistent-type-assertions rule bans them outright). */
function invokePostcssFactory(
  factory: unknown,
  arg?: Readonly<Record<string, unknown>>,
): AcceptedPlugin {
  if (!isCallable(factory)) {
    throw new Error("expected a callable PostCSS plugin factory");
  }
  const plugin = factory(arg);
  if (!isPostcssPlugin(plugin)) {
    throw new Error("PostCSS plugin factory did not return a plugin object");
  }
  return plugin;
}

// No dev proxy: the console takes full ws:// URLs and WebSocket connections are not same-origin-restricted, so `vite` (dev) serves the page and the page dials the node directly.
export default defineConfig({
  plugins: [
    react(),
    vanillaExtractPlugin(),
    // registerType "prompt" rather than "autoUpdate": this console holds live WebSocket/WebRTC sessions, and an auto-reloading SW update would silently drop them mid-use. src/components/PwaUpdatePrompt.tsx surfaces the update instead and lets the operator choose when to reload. includeAssets covers the favicon, which isn't itself a manifest icon so the base globPatterns wouldn't otherwise know to precache it as an app-shell asset.
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg"],
      manifest: pwaManifest,
      workbox: {
        // This is a single-route SPA (see App.tsx), so any navigation while offline should still resolve to the cached shell rather than a network error.
        navigateFallback: "index.html",
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
  css: {
    postcss: {
      plugins: [
        invokePostcssFactory(postcssPresetMantine),
        invokePostcssFactory(postcssSimpleVars, {
          variables: MANTINE_BREAKPOINTS,
        }),
      ],
    },
  },
  build: {
    outDir: "dist",
  },
  test: {
    // test/e2e/*.spec.ts matches vitest's own default test-file glob, but those are @playwright/test specs (run via `pnpm test:e2e`, not `pnpm test`) with a fixture-based signature vitest doesn't understand -- exclude the whole directory rather than let vitest try and fail to run them.
    exclude: ["test/e2e/**", "**/node_modules/**"],
    // Per-file environment overrides (main.test.ts opts into jsdom via its own `// @vitest-environment jsdom` docblock) rather than a global switch here: jsdom runs its own separate JS realm, so a Uint8Array built under the default Node environment fails `instanceof` checks against jsdom's own Uint8Array constructor -- confirmed directly, switching this globally broke indexeddb-storage.test.ts and web-crypto-identity.test.ts, neither of which touches the DOM at all.
  },
});
