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
      // Browser globals for the app source, node globals for vite/vitest config and tests -- the tests drive the browser-shaped adapter under Node, which provides the same WebSocket global natively.
      globals: { ...globals.browser, ...globals.node },
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
    // A frame-log entry has no identity of its own -- two identical frames sent back to back are indistinguishable, so position in this append-only log is the only key available. Scoped to this one file rather than disabled project-wide, since every other list this package renders (the peer directory, room messages) does have a real key (device-id, message-id).
    files: ["src/components/ConnectionPanel.tsx"],
    rules: {
      "react/no-array-index-key": "off",
    },
  },
  eslintPluginPrettierRecommended,
);
