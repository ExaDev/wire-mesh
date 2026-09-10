// Produces src/generated/protocol.ts from ../../../spec/protocol.cddl via cddl.js. Run `pnpm generate` after the spec changes, then `pnpm test` to confirm generated schemas still round-trip conformance/'s golden vectors. CI regenerates and diffs against the committed file (see .github/workflows/ci.yml's core-verify job) so protocol.ts is never edited by hand.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "cddl.js/parse";
import { emitModule } from "cddl.js/emitter";

const specPath = fileURLToPath(
  new URL("../../../spec/protocol.cddl", import.meta.url),
);
const outputPath = fileURLToPath(
  new URL("src/generated/protocol.ts", import.meta.url),
);

const parsed = parse(specPath);
const source = emitModule(parsed);
writeFileSync(outputPath, source);
console.log(`wrote ${outputPath}`);
