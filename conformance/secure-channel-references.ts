// Checks the vector file makes on itself before it is written: every name the `secure_channel` section refers to is a top-level vector, and no two vectors share a name. Split from secure-channel-vectors.ts, which sits at this repo's max-lines cap.

import { type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";

/** The layout of the `secure_channel` section: raised when a field is renamed, retyped or removed, so a consumer can tell a layout it does not know from one it does. */
export const LAYOUT_VERSION = 2;

export function jsonArray(value: JsonWire | undefined): readonly JsonWire[] {
  if (!Array.isArray(value)) {
    throw new Error("expected a JSON array while checking references");
  }

  return value;
}

export function jsonField(value: JsonWire | undefined, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object while checking references");
  }
  for (const [name, field] of Object.entries(value)) {
    if (name === key && typeof field === "string") {
      return field;
    }
  }

  throw new Error(`expected ${key} to be a string while checking references`);
}

/** Fails generation when two top-level vectors share a name or a name the section refers to is not a vector, since a consumer would otherwise find that only when it fails. */
export function assertReferencesResolve(
  vectors: readonly Vector[],
  references: readonly string[],
): void {
  const names = new Set<string>();
  for (const vector of vectors) {
    if (names.has(vector.name)) {
      throw new Error(`two vectors are named ${vector.name}`);
    }
    names.add(vector.name);
  }
  for (const reference of references) {
    if (!names.has(reference)) {
      throw new Error(`${reference} is referred to but is not a vector`);
    }
  }
}
