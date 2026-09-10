import { exadevConfig } from "@exadev/eslint-config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default exadevConfig(
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
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    // The CLI entrypoint's own startup message is genuine console output, not library logging -- no other file in this package (or the workspace) has a precedent for console use, so this narrow, file-scoped override (rather than an inline eslint-disable, which noInlineConfig above blocks anyway) is the clearest way to permit it.
    files: ["src/server.ts"],
    rules: {
      "no-console": "off",
    },
  },
  eslintPluginPrettierRecommended,
);
