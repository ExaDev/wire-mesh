import { exadevConfig } from "@exadev/eslint-config";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default defineConfig(
  exadevConfig(
    {},
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
      },
    },
    {
      // The CLI entrypoint's own startup message is genuine console output, not library logging, matching wire-mesh-node's own identical narrow, file-scoped override.
      files: ["src/server.ts"],
      rules: {
        "no-console": "off",
      },
    },
  ),
  eslintPluginPrettierRecommended,
);
