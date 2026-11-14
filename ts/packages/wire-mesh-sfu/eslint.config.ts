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
    // The CLI entrypoint's own startup message is genuine console output, not library logging, matching wire-mesh's own identical narrow, file-scoped override.
    files: ["src/server.ts"],
    rules: {
      "no-console": "off",
    },
  },
  eslintPluginPrettierRecommended,
);
