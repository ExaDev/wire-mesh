import { exadevConfig } from "@exadev/eslint-config";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

// Lints the workspace root's own tooling configs, and nothing else.
//
// packages/** stays ignored: each package keeps its own eslint.config.ts because file scoping and tsconfig wiring are genuinely per-package concerns, and a root run that also walked them would apply this program's tsconfig to source files it does not contain.
export default defineConfig(
  exadevConfig(
    {},
    {
      ignores: ["packages/**", "node_modules", ".turbo"],
    },
    {
      languageOptions: {
        parserOptions: {
          project: ["./tsconfig.json"],
          tsconfigRootDir: import.meta.dirname,
        },
        globals: { ...globals.node },
      },
    },
    {
      files: ["**/*.ts", "**/*.mts", "**/*.cts"],
      rules: {
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { fixStyle: "inline-type-imports" },
        ],
      },
    },
  ),
  eslintPluginPrettierRecommended,
);
