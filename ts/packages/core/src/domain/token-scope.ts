import type { TokenClaims } from "../generated/protocol.js";

/**
 * Extracted out of tokens.ts specifically so token-predicates.ts (the generic evaluator's own delegate handlers) and tokens.ts (the chain walk, and its re-export for capability-grant.ts) can both depend on this pure, no-domain-imports module without creating an import cycle between the two -- tokens.ts imports evaluateNarrowing from token-predicates.ts, and token-predicates.ts's own scope-narrows/bearer-is handlers need these exact comparisons, so neither of those two files may import the other.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** True when the path contains a "." or ".." segment. Purely lexical prefix comparison would let "/work/../org" pass under "/work" -- a path that normalises outside the parent -- so any relative segment fails the narrowing comparison wholesale: fail-closed rather than reimplementing path normalisation, consistent with how empty, case-different, and non-boundary-prefixed paths already behave. */
function hasRelativeSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/** True when childPath is parentPath or a descendant of it, compared on "/"-segment boundaries: "/work/sub" narrows "/work", but "/workbook" does NOT narrow "/work" despite the string prefix, because "book" continues the same segment. Paths containing "." or ".." segments never narrow anything (see hasRelativeSegment). */
function pathNarrows(childPath: string, parentPath: string): boolean {
  if (hasRelativeSegment(childPath) || hasRelativeSegment(parentPath)) {
    return false;
  }
  if (childPath === parentPath) return true;
  if (!childPath.startsWith(parentPath)) return false;
  if (parentPath.endsWith("/")) return true;
  return childPath.charAt(parentPath.length) === "/";
}

/**
 * True when childScope narrows parentScope per tokens.cddl ("each hop can only narrow authority, never widen it"): the kind must be identical (a different kind is a different kind of authority, not a narrower one), and a parent with a path requires the child to carry an equal-or-descendant path -- an absent child path means the kind's whole-scope root, which is wider than any path-narrowed parent. A parent with no path (whole-scope root) lets any child path under the same kind through. Exported for capability-grant.ts's own obligation 4 (an unsolicited push's embedded token must equal-or-root the enclosing request's own scope), which is exactly this same narrowing relation applied outside a delegation chain, and for token-predicates.ts's own `scope-narrows` delegate handler.
 */
export function scopeNarrows(
  parent: TokenClaims["scope"],
  child: TokenClaims["scope"],
): boolean {
  if (parent.kind !== child.kind) return false;
  if (parent.path === undefined) return true;
  if (child.path === undefined) return false;
  return pathNarrows(child.path, parent.path);
}
