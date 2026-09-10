import { defineConfig } from "tsdown";

// codec.ts is the one module meant to be consumed as a real package (by generate.ts and verify.test.ts today, and potentially by rust/ts's own conformance-check tooling later): built dual ESM/CJS with declarations so it resolves correctly under every module system, not just the one this repo happens to run scripts with. attw verifies that claim directly rather than trusting it.
export default defineConfig({
  entry: ["codec.ts"],
  format: ["esm", "cjs"],
  dts: true,
  exports: true,
  attw: { profile: "node16" },
  clean: true,
});
