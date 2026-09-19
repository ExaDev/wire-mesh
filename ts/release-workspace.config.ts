import type {
  PublishPluginSpec,
  ReleaseWorkspaceOptions,
} from "@exadev/semantic-release-workspace";

/** The pipeline every package runs. A package whose manifest sets `"private": true` runs it without `@semantic-release/github`, which the orchestrator drops for such a package on its own. */
const publishPlugins: readonly PublishPluginSpec[] = [
  "@semantic-release/changelog",
  ["@semantic-release/npm", { npmPublish: true }],
  "@semantic-release/github",
];

/**
 * Runs on `main`, once per push, through `@exadev/semantic-release-workspace` rather than semantic-release directly.
 *
 * The orchestrator discovers every package from pnpm-workspace.yaml, orders them so a package releases only after each workspace sibling it depends on has, and runs semantic-release per package with the commit list path-filtered to that package's own directory and its tags in `name@version` form. This workspace sits at ts/ rather than the repository root, and the orchestrator scopes each package's path filter against the repository toplevel via `git rev-parse --show-prefix`, so a commit touching only rust/ or spec/ releases nothing here.
 *
 * That tag format is not the one this repository's two hand-rolled per-package release jobs used: `core-v1.58.2` and `node-v1.0.1` then, `wire-mesh-core@1.58.2` and `wire-mesh@1.0.1` now. semantic-release derives a package's previous version from the last tag matching the format it is configured with and finds nothing at all without one, so each package needed a tag in the new format created at the commit its last old-format tag names. Without one, both would have restarted at 1.0.0 and collided with versions the registry already holds. The old tags are left in place; nothing reads them any more.
 *
 * `commitStrategy: "single"` produces one commit for the whole run, every version bump, changelog write and dependency-range rewrite together, instead of one commit per released package plus one per bump. main's ruleset requires every change to arrive through a pull request, so each of those pushes is a bypass; one combined push is both fewer bypasses and atomic, leaving no half-released state if the run dies partway. `@semantic-release/git` is deliberately absent from the plugin list because of it: that plugin's own prepare step would make exactly the per-package commit this mode exists to replace, and the orchestrator rejects the combination outright rather than producing both.
 *
 * Three of the five packages here are private. They still take part in the run, because what a dependent needs from an upstream sibling is its version bump, its `name@version` tag and the rewrite of the dependent's own dependency range, and a private package produces all three: `@semantic-release/npm` skips only the publish itself. `@exadev/wire-mesh-web-console`'s build output is copied into wire-mesh's own dist, so wire-mesh has to republish when the console changes. With commits path-filtered per package, the only thing that forces it is web-console releasing and the orchestrator rewriting wire-mesh's dependency range on it.
 *
 * What a private package does not need is a public GitHub Release, and one created for it actively misled: `@semantic-release/github` marks every release it creates from the release branch as the repository's Latest, with no option to do otherwise, so whichever package the run released last took the label. Topological order puts `wire-mesh-sfu` last in every run, because it depends on both published packages, so GitHub advertised an unpublishable package as the current release. The orchestrator reads `private` from each manifest and leaves that one plugin off those pipelines itself, which removes their Releases and nothing else, and the label settles on `wire-mesh` on its own.
 */
const config: Pick<
  ReleaseWorkspaceOptions,
  "branches" | "commitStrategy" | "plugins" | "analyzeCommits" | "generateNotes"
> = {
  branches: ["main"],
  commitStrategy: "single",
  plugins: publishPlugins,
  analyzeCommits: {
    preset: "conventionalcommits",
    releaseRules: [
      { breaking: true, release: "major" },
      { type: "feat", release: "minor" },
      { type: "fix", release: "patch" },
      { type: "perf", release: "patch" },
      { type: "revert", release: "patch" },
      { type: "refactor", release: "patch" },
      { type: "docs", release: "patch" },
      { type: "style", release: "patch" },
      { type: "test", release: "patch" },
      { type: "build", release: "patch" },
      { type: "ci", release: "patch" },
      { type: "chore", release: "patch" },
    ],
  },
  generateNotes: {
    // The conventionalcommits preset, not angular: it is the one that groups the changelog by commit type, and the presetConfig below names every type's section. It renders only against conventional-changelog-writer 9 or newer, which @semantic-release/release-notes-generator does not itself depend on. See the pnpm override that supplies it.
    preset: "conventionalcommits",
    presetConfig: {
      types: [
        { type: "feat", section: "Features" },
        { type: "fix", section: "Bug Fixes" },
        { type: "perf", section: "Performance Improvements" },
        { type: "revert", section: "Reverts" },
        { type: "refactor", section: "Code Refactoring" },
        { type: "docs", section: "Documentation" },
        { type: "style", section: "Styles" },
        { type: "test", section: "Tests" },
        { type: "build", section: "Build System" },
        { type: "ci", section: "Continuous Integration" },
        { type: "chore", section: "Miscellaneous Chores" },
      ],
    },
  },
};

export default config;
