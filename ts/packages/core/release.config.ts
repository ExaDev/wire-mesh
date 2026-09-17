import type { GlobalConfig } from "semantic-release";

const config: GlobalConfig = {
  branches: ["main"],
  repositoryUrl: "https://github.com/ExaDev/wire-mesh.git",
  tagFormat: "core-v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        releaseRules: [
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "refactor", release: "patch" },
          { type: "perf", release: "patch" },
          { type: "docs", release: "patch" },
          { type: "style", release: "patch" },
          { type: "test", release: "patch" },
          { type: "build", release: "patch" },
          { type: "ci", release: "patch" },
          { type: "chore", release: "patch" },
          { breaking: true, release: "major" },
        ],
      },
    ],
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    "@semantic-release/github",
  ],
};

export default config;
