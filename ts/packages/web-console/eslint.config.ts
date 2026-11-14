import { exadevConfig } from "@exadev/eslint-config";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default defineConfig(
  ...exadevConfig(),
  {
    ignores: ["dist", "coverage", "node_modules", ".turbo"],
  },
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      // Browser globals for the app source, node globals for vite/vitest config and tests -- the tests drive the browser-shaped adapter under Node, which provides the same WebSocket global natively.
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      // A promise nobody awaits is an unhandled rejection when it fails: `void` is not a handler, so the rule does not accept it as one.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: false,
        },
      ],
    },
  },
  {
    // A test starts work it then inspects, and its own runner reports a rejection nothing handled, so the production rule against bare `void` starts does not apply to it.
    files: ["test/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: true },
      ],
    },
  },
  {
    // A frame-log entry has no identity of its own -- two identical frames sent back to back are indistinguishable, so position in this append-only log is the only key available. Scoped to this one file rather than disabled project-wide, since every other list this package renders (the peer directory, room messages) does have a real key (device-id, message-id).
    files: ["src/components/ConnectionPanel.tsx"],
    rules: {
      "react/no-array-index-key": "off",
    },
  },
  {
    /* Runtime-specific API in browser source. A timer handle's `unref()`, `process`, `Buffer`, `node:` modules and the like exist only in Node: `setTimeout` returns a number in a browser or a Worker, so `timer.unref()` throws there, and a throw inside a consumer loop's failure handling ends the loop. Source that can run outside Node asks the runtime-neutral helper (src/domain/timers.ts in wire-mesh-core) or does not use them. */
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^(unref|ref|hasRef)$/]",
          message:
            "A timer handle's unref(), ref() and hasRef() exist only in Node; use unrefIfSupported from wire-mesh-core's timers module.",
        },
      ],
      "no-restricted-globals": [
        "error",
        ...[
          "process",
          "Buffer",
          "setImmediate",
          "clearImmediate",
          "__dirname",
          "__filename",
          "require",
        ].map((name) => ({
          name,
          message: `${name} exists only in Node, and this source can run in a browser or a Worker.`,
        })),
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "node: modules exist only in Node, and this source can run in a browser or a Worker.",
            },
          ],
        },
      ],
    },
  },
  eslintPluginPrettierRecommended,
);
