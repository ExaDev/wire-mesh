/**
 The layout of a file-backed key-value store, as pure functions: which keys the layout accepts, and the file a key names. The layout is shared with the Rust core's `domain::fs_layout`, so a directory written by either implementation is read by the other. A key is a relative path of `/`-separated segments under the store's directory, and its file holds the value's bytes and nothing else.
 
A key that `path.join` would rewrite (empty, `.` and `..` segments, a doubled or trailing separator) or that leaves the directory would be stored under a name other than its own and listed back as another key, so it is refused. The refusals are the same on every host: `/` is the only separator, and a backslash is refused so that the layout does not depend on the operating system.
 */

/** Why a key is not a key of the layout, by the name the conformance vectors use. */
export type KeyRefusal =
  | "empty"
  | "nul"
  | "backslash"
  | "absolute"
  | "empty_segment"
  | "dot_segment"
  | "parent_segment";

/**
 * Checks `key` against the layout. The first rule it breaks is the refusal, taken in this order: empty, NUL, backslash, a leading slash, then each segment from the left (empty, `.`, `..`). Undefined when the key is a key of the layout.
 */
export function refusalOfKey(key: string): KeyRefusal | undefined {
  if (key === "") return "empty";
  if (key.includes("\0")) return "nul";
  if (key.includes("\\")) return "backslash";
  if (key.startsWith("/")) return "absolute";
  for (const segment of key.split("/")) {
    if (segment === "") return "empty_segment";
    if (segment === ".") return "dot_segment";
    if (segment === "..") return "parent_segment";
  }

  return undefined;
}

/** Thrown by a storage operation given a key the layout refuses, rather than storing it under another name. */
export class InvalidStorageKeyError extends Error {
  readonly refusal: KeyRefusal;

  constructor(key: string, refusal: KeyRefusal) {
    super(`invalid storage key ${JSON.stringify(key)}: ${refusal}`);
    this.name = "InvalidStorageKeyError";
    this.refusal = refusal;
  }
}

/** The path segments of a key of the layout, in order: the file is these joined onto the store's directory. Throws InvalidStorageKeyError for a key the layout refuses. */
export function segmentsOfKey(key: string): string[] {
  const refusal = refusalOfKey(key);
  if (refusal !== undefined) {
    throw new InvalidStorageKeyError(key, refusal);
  }

  return key.split("/");
}
