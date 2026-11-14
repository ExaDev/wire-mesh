import { exadevConfig } from "@exadev/eslint-config";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default defineConfig(
  ...exadevConfig(),
  {
    // scripts/ holds plain-JS operational scripts (the live-runtime check) with no TS project to type them against.
    ignores: [
      "dist",
      "coverage",
      "node_modules",
      ".turbo",
      ".wrangler",
      "scripts",
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
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
    /* Runtime-specific API in Worker source. A timer handle's `unref()`, `process`, `Buffer`, `node:` modules and the like exist only in Node: `setTimeout` returns a number in a browser or a Worker, so `timer.unref()` throws there, and a throw inside a consumer loop's failure handling ends the loop. Source that can run outside Node asks the runtime-neutral helper (src/domain/timers.ts in wire-mesh-core) or does not use them. */
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
