import { defineConfig } from "tsdown";

// Every real module gets its own build entry rather than a re-exporting index.ts -- the barrel-policy lint rule requires importing straight from the module that owns each export. src/generated/protocol.ts is committed, machine-generated output (see generate.ts); it's built here like any other module (real code that needs to compile and bundle correctly) but excluded from eslint's own strict authored-code rules (see eslint.config.ts's ignores) since rules like no-use-before-define don't make sense for its z.lazy()-wrapped mutually-recursive schemas.
export default defineConfig({
  entry: [
    "src/generated/protocol.ts",
    "src/generated/runtime.ts",
    "src/ports/transport.ts",
    "src/ports/storage.ts",
    "src/ports/identity.ts",
    "src/ports/clock.ts",
    "src/domain/handshake.ts",
    "src/domain/tokens.ts",
    "src/adapters/tcp-transport.ts",
    "src/adapters/memory-storage.ts",
    "src/adapters/node-identity.ts",
    "src/adapters/system-clock.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  exports: true,
  attw: { profile: "node16" },
  clean: true,
});
