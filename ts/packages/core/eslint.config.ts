import { exadevConfig } from "@exadev/eslint-config";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default defineConfig(
  ...exadevConfig(),
  {
    ignores: [
      "dist",
      "wasm-dist",
      "coverage",
      "node_modules",
      ".turbo",
      "src/generated",
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
    /* These modules export signatures this package publishes: every module
       under src/ is a subpath export except those named in tsdown.config.ts's
       INTERNAL_MODULES. A positional parameter list is part of that public API,
       so folding it into an options object is a breaking change that needs a
       major release, not a lint fix. The exemption is per file and limited to
       the two parameter-shape rules. */
    files: [
      "src/adapters/threshold-identity.ts",
      "src/adapters/threshold-wasm.ts",
      "src/domain/bulk.ts",
      "src/domain/capability-grant.ts",
      "src/domain/capability-request.ts",
      "src/domain/direct-manage-request.ts",
      "src/domain/mesh-session.ts",
      "src/domain/room-rekey.ts",
      "src/domain/token-predicates.ts",
      "src/domain/topology.ts",
    ],
    rules: {
      "max-params": "off",
      "exadev/prefer-options-object-param": "off",
    },
  },
  {
    /* This fake stands in for MeshSession.sendManageRequest, so it keeps that
       published method's positional parameter list. */
    files: ["test/threshold-network-coordinator.integration.test.ts"],
    rules: { "exadev/prefer-options-object-param": "off" },
  },
  {
    /* Runtime-specific API in shared source (core): the adapters named here are Node-only by design, and timers.ts is the one place that inspects a handle. A timer handle's `unref()`, `process`, `Buffer`, `node:` modules and the like exist only in Node: `setTimeout` returns a number in a browser or a Worker, so `timer.unref()` throws there, and a throw inside a consumer loop's failure handling ends the loop. Source that can run outside Node asks the runtime-neutral helper (src/domain/timers.ts in wire-mesh-core) or does not use them. */
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      "src/adapters/node-*.ts",
      "src/adapters/tcp-transport.ts",
      "src/adapters/tls-transport.ts",
      "src/domain/timers.ts",
      "src/domain/own-version.ts",
    ],
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
