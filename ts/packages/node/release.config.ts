import type { GlobalConfig } from "semantic-release";

const config: GlobalConfig = {
  branches: ["main"],
  repositoryUrl: "https://github.com/ExaDev/wire-mesh.git",
  tagFormat: "node-v${version}",
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
    // npmPublish is disabled here because @semantic-release/npm's own publish step shells out to plain `npm publish <dir>`, which has no awareness of pnpm's workspace protocol and would ship the literal string "workspace:*" as this package's wire-mesh-core dependency. Its prepare step (bumping this package's own version) still runs regardless of npmPublish, so the exec step below packs and publishes a package.json with wire-mesh-core's workspace:* range already resolved to a concrete version by pnpm.
    ["@semantic-release/npm", { npmPublish: false }],
    [
      "@semantic-release/exec",
      {
        publishCmd:
          'tarball="$(mktemp -d)/wire-mesh.tgz" && pnpm pack --out "$tarball" && npm publish "$tarball"',
      },
    ],
    "@semantic-release/github",
  ],
};

export default config;
