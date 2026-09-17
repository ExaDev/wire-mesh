import type { PartialStrykerOptions } from "@stryker-mutator/api/core";

// A real .ts file, not stryker.config.mjs with a `@type` JSDoc annotation (Stryker's own documented pattern): Stryker's own config loader is a plain `import()` under the hood (ConfigReader#importJSConfig in @stryker-mutator/core) with no opinion at all about the extension it is given, and Node's own ESM loader on this workspace's pinned version (.tool-versions: nodejs 26) strips a .ts file's type syntax natively with no flag and no loader hook -- so `stryker run stryker.config.ts` resolves straight through that native support, with no shim file, and Stryker's own option validation still runs afterward exactly as it would for a .js config.
//
// testRunner is "command", not "@stryker-mutator/vitest-runner", despite this package running on vitest: vitest-runner@10.0.0 crashes on init against vitest@5.0.0 with "TypeError: Converting circular structure to JSON" while serialising vitest's own resolved config (VitestTestRunner.init, vitest-test-runner.js), a confirmed upstream incompatibility with no fix or compatible version pairing available (see stryker-mutator/stryker-js's vitest-runner issue tracker; independently corroborated by Chris0Jeky/Taskdeck#3038 hitting the identical "0.00 tests per mutant" symptom against the same vitest major). The command runner re-runs `pnpm test` as a subprocess per mutant instead of driving vitest in-process, so it loses per-test coverage analysis (every mutant re-runs the whole suite rather than only its covering tests) but actually produces a real result. Revisit once vitest-runner ships a fix for this.
const config: PartialStrykerOptions = {
  packageManager: "pnpm",
  // src/generated/protocol.ts is cddl.js output, not hand-written logic -- mutating it would just generate noise against code nobody edits directly, exactly the exclusion the issue that added this config asked for.
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/generated/**"],
  testRunner: "command",
  // test/conformance.unit.test.ts is excluded here, not mutated around: Stryker's sandbox for a command-runner mutant is confined to this package's own directory, but that test reads its vectors from a sibling package (`../../../../conformance/*.json`, outside the sandbox root) -- it fails with ENOENT for every mutant regardless of the mutation, which is a sandboxing mismatch, not a real "no coverage" signal. `_conformance-check` already runs this suite as its own separate, unmutated CI step.
  commandRunner: {
    command: "pnpm exec vitest run --exclude test/conformance.unit.test.ts",
  },
  plugins: ["@stryker-mutator/typescript-checker"],
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  // The command runner only sees the subprocess's exit code, never which tests ran -- there's no per-test signal to analyse coverage from, so Stryker itself forces this to "off" for this runner regardless of what's configured here. "ignoreStatic" is incompatible with coverage analysis "off" (Stryker refuses to start otherwise) -- moot anyway, since the command runner re-runs the whole suite for every mutant regardless of whether it's static or per-test, so there's no separate static-mutant cost to skip here the way there would be under a coverage-aware runner.
  coverageAnalysis: "off",
  incremental: true,
  // dist/coverage/.turbo are build/tooling output Stryker would otherwise copy into every mutant's own sandbox for nothing -- none of it is ever read by a test.
  ignorePatterns: ["dist", "coverage", ".turbo"],
  reporters: ["progress", "clear-text", "html"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  concurrency: 4,
  timeoutMS: 30_000,
  thresholds: {
    high: 80,
    low: 60,
    // No `break` yet -- this config's own job is a first baseline report (wire-mesh#67); fixing what it finds and setting a real, measured break threshold is wire-mesh#68's own separate work. Picking a break value before a baseline exists would be exactly the arbitrary-magic-number pattern this codebase's own no-magic-numbers convention already refuses elsewhere.
  },
};

export default config;
