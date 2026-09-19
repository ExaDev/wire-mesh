import { describe, expect, it } from "vitest";
import config from "../tsdown.config.ts";

/**
 * Whether tsdown would leave the module with this absolute id out of the bundle.
 *
 * Only the RegExp entries of a `neverBundle` array are consulted, because those are the only forms the config uses.
 */
function isNeverBundled(id: string): boolean {
  const neverBundle = config.deps?.neverBundle;
  if (!Array.isArray(neverBundle)) {
    throw new Error("tsdown.config.ts must list its neverBundle patterns");
  }
  return neverBundle.some(
    (pattern) => pattern instanceof RegExp && pattern.test(id),
  );
}

const CHECKOUT_ROOTS = [
  "/home/dev/wire-mesh",
  "/home/dev/wasm-dist/wire-mesh",
  "/home/dev/wasm-dist",
];

describe("tsdown neverBundle patterns", () => {
  it.each(CHECKOUT_ROOTS)(
    "keeps the wasm-bindgen glue external under %s",
    (root) => {
      expect(
        isNeverBundled(
          `${root}/ts/packages/core/wasm-dist/wire_mesh_threshold_wasm.js`,
        ),
      ).toBe(true);
    },
  );

  it.each(CHECKOUT_ROOTS)(
    "bundles ordinary source modules under %s",
    (root) => {
      expect(
        isNeverBundled(`${root}/ts/packages/core/src/domain/mesh-session.ts`),
      ).toBe(false);
      expect(
        isNeverBundled(
          `${root}/ts/packages/core/src/adapters/threshold-wasm.ts`,
        ),
      ).toBe(false);
    },
  );

  it("keeps the package manifest external", () => {
    expect(
      isNeverBundled("/home/dev/wire-mesh/ts/packages/core/package.json"),
    ).toBe(true);
  });
});
