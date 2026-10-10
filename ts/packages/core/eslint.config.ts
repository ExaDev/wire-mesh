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
  eslintPluginPrettierRecommended,
);
