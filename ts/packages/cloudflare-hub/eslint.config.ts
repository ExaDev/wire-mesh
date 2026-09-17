import { exadevConfig } from "@exadev/eslint-config";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default defineConfig(
  exadevConfig(
    {},
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
      },
    },
  ),
  eslintPluginPrettierRecommended,
);
