/* file-storage.v1.json: the layout of a file-backed key-value store, and what each implementation's storage does to a directory.

   The file has no wire vectors: it pins a layout on disk. Its `file_storage` section holds two lists. `key_layout` gives, for each key, the path of the file that holds it or the reason the layout refuses it, so the pure layout functions of both implementations (`refusalOfKey` and `segmentsOfKey`, `check_key` and `key_to_relative_path`) are checked without a filesystem. `scenarios` start from a directory (every file under it, as a `/`-joined path and its content in hex), run operations on a storage over a copy of it, and record what each returns and the whole directory after it, so the TypeScript and the Rust storage are checked to read the files the other writes, to write what the other reads, and to leave nothing else behind. The outcomes are written by hand from the layout, never produced by an implementation. */

import type { JsonWire } from "@exadev/wire-mesh-conformance";

export const FILE_STORAGE_LAYOUT_VERSION = 1;

/** A directory as the file records it: every file under it with its content in hex, in path order. */
type Directory = Record<string, string>;

type Step =
  | { op: "get"; key: string; returns: string | null }
  | {
      op: "set";
      key: string;
      value: string;
      returns: "ok" | "error" | "refused";
    }
  | { op: "delete"; key: string; returns: "ok" | "error" | "refused" }
  | { op: "keys"; prefix: string; returns: readonly string[] };

interface Scenario {
  name: string;
  start: Directory;
  steps: readonly (Step & { directory: Directory })[];
}

const KEY_CASES: readonly {
  name: string;
  key: string;
  expected: { path: string } | { refusal: string };
}[] = [
  { name: "a_single_segment", key: "a", expected: { path: "a" } },
  {
    name: "a_nested_key_is_a_nested_path",
    key: "data/deadbeef/entry/1",
    expected: { path: "data/deadbeef/entry/1" },
  },
  {
    name: "a_dotfile_is_an_ordinary_name",
    key: ".DS_Store",
    expected: { path: ".DS_Store" },
  },
  {
    name: "three_dots_are_an_ordinary_name",
    key: "a/.../b",
    expected: { path: "a/.../b" },
  },
  {
    name: "a_dot_inside_a_name_is_ordinary",
    key: "a./.b/c..",
    expected: { path: "a./.b/c.." },
  },
  {
    name: "spaces_and_non_ascii_are_ordinary",
    key: "a b/café/\u{1f600}",
    expected: { path: "a b/café/\u{1f600}" },
  },
  { name: "the_empty_key", key: "", expected: { refusal: "empty" } },
  { name: "a_nul", key: "a\u0000b", expected: { refusal: "nul" } },
  { name: "a_backslash", key: "a\\b", expected: { refusal: "backslash" } },
  { name: "a_leading_slash", key: "/a", expected: { refusal: "absolute" } },
  { name: "the_root", key: "/", expected: { refusal: "absolute" } },
  {
    name: "a_doubled_slash",
    key: "a//b",
    expected: { refusal: "empty_segment" },
  },
  {
    name: "a_trailing_slash",
    key: "a/",
    expected: { refusal: "empty_segment" },
  },
  { name: "a_dot_segment", key: "a/./b", expected: { refusal: "dot_segment" } },
  { name: "only_a_dot", key: ".", expected: { refusal: "dot_segment" } },
  {
    name: "a_parent_segment",
    key: "a/../b",
    expected: { refusal: "parent_segment" },
  },
  { name: "only_a_parent", key: "..", expected: { refusal: "parent_segment" } },
  {
    name: "a_parent_segment_that_leaves_the_directory",
    key: "../outside",
    expected: { refusal: "parent_segment" },
  },
  {
    name: "a_nul_is_named_before_a_backslash",
    key: "a\u0000\\",
    expected: { refusal: "nul" },
  },
  {
    name: "a_backslash_is_named_before_a_leading_slash",
    key: "/a\\",
    expected: { refusal: "backslash" },
  },
  {
    name: "a_leading_slash_is_named_before_a_parent_segment",
    key: "/..",
    expected: { refusal: "absolute" },
  },
  {
    name: "segments_are_read_from_the_left",
    key: "./..",
    expected: { refusal: "dot_segment" },
  },
  {
    name: "an_empty_segment_is_named_before_a_later_parent",
    key: "a//..",
    expected: { refusal: "empty_segment" },
  },
];

const hexOf = (text: string): string =>
  Buffer.from(text, "utf8").toString("hex");

const EMPTY: Directory = {};
const ONE: Directory = { a: hexOf("one") };
const NESTED: Directory = { "d/e": hexOf("nested") };
const TREE: Directory = {
  "a/1": hexOf("a1"),
  "a/10": hexOf("a10"),
  "a/2": hexOf("a2"),
  "b/2": hexOf("b2"),
  c: hexOf("c"),
};

function sorted(directory: Readonly<Directory>): Directory {
  return Object.fromEntries(
    Object.entries(directory).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function plus(
  directory: Readonly<Directory>,
  more: Readonly<Directory>,
): Directory {
  return sorted({ ...directory, ...more });
}

function without(directory: Readonly<Directory>, key: string): Directory {
  return Object.fromEntries(
    Object.entries(directory).filter(([path]) => path !== key),
  );
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "a_missing_directory_holds_nothing",
    start: EMPTY,
    steps: [
      { op: "get", key: "a", returns: null, directory: EMPTY },
      { op: "keys", prefix: "", returns: [], directory: EMPTY },
      { op: "delete", key: "a", returns: "ok", directory: EMPTY },
    ],
  },
  {
    name: "a_directory_written_elsewhere_is_read",
    start: TREE,
    steps: [
      { op: "get", key: "a/10", returns: hexOf("a10"), directory: TREE },
      { op: "get", key: "c", returns: hexOf("c"), directory: TREE },
      { op: "get", key: "a/3", returns: null, directory: TREE },
      {
        op: "keys",
        prefix: "",
        returns: ["a/1", "a/10", "a/2", "b/2", "c"],
        directory: TREE,
      },
      {
        op: "keys",
        prefix: "a/",
        returns: ["a/1", "a/10", "a/2"],
        directory: TREE,
      },
      { op: "keys", prefix: "a/1", returns: ["a/1", "a/10"], directory: TREE },
      { op: "keys", prefix: "x", returns: [], directory: TREE },
    ],
  },
  {
    name: "a_value_is_the_whole_file",
    start: EMPTY,
    steps: [
      { op: "set", key: "k", value: "", returns: "ok", directory: { k: "" } },
      { op: "get", key: "k", returns: "", directory: { k: "" } },
      {
        op: "set",
        key: "k",
        value: "00ff0a0d00",
        returns: "ok",
        directory: { k: "00ff0a0d00" },
      },
      {
        op: "get",
        key: "k",
        returns: "00ff0a0d00",
        directory: { k: "00ff0a0d00" },
      },
    ],
  },
  {
    name: "a_set_creates_nested_directories_and_replaces_in_place",
    start: EMPTY,
    steps: [
      {
        op: "set",
        key: "data/ab/entry/1",
        value: "0a0b0c",
        returns: "ok",
        directory: { "data/ab/entry/1": "0a0b0c" },
      },
      {
        op: "set",
        key: "data/ab/entry/1",
        value: "01",
        returns: "ok",
        directory: { "data/ab/entry/1": "01" },
      },
      {
        op: "set",
        key: "data/ab/head",
        value: hexOf("1"),
        returns: "ok",
        directory: { "data/ab/entry/1": "01", "data/ab/head": hexOf("1") },
      },
    ],
  },
  {
    name: "a_delete_removes_the_file_and_tolerates_absence",
    start: ONE,
    steps: [
      { op: "delete", key: "a", returns: "ok", directory: EMPTY },
      { op: "delete", key: "a", returns: "ok", directory: EMPTY },
      { op: "get", key: "a", returns: null, directory: EMPTY },
    ],
  },
  {
    name: "a_delete_leaves_the_other_files",
    start: TREE,
    steps: [
      {
        op: "delete",
        key: "a/10",
        returns: "ok",
        directory: without(TREE, "a/10"),
      },
      {
        op: "keys",
        prefix: "a/",
        returns: ["a/1", "a/2"],
        directory: without(TREE, "a/10"),
      },
    ],
  },
  {
    name: "a_key_the_layout_refuses_is_refused_by_every_operation_and_writes_nothing",
    start: ONE,
    steps: [
      { op: "get", key: "", returns: "refused", directory: ONE },
      { op: "set", key: "", value: "01", returns: "refused", directory: ONE },
      { op: "delete", key: "", returns: "refused", directory: ONE },
      { op: "get", key: "../a", returns: "refused", directory: ONE },
      {
        op: "set",
        key: "../a",
        value: "01",
        returns: "refused",
        directory: ONE,
      },
      { op: "delete", key: "../a", returns: "refused", directory: ONE },
      {
        op: "set",
        key: "x//y",
        value: "01",
        returns: "refused",
        directory: ONE,
      },
      {
        op: "set",
        key: "x/./y",
        value: "01",
        returns: "refused",
        directory: ONE,
      },
      { op: "set", key: "/x", value: "01", returns: "refused", directory: ONE },
      { op: "set", key: "x/", value: "01", returns: "refused", directory: ONE },
      {
        op: "set",
        key: "x\\y",
        value: "01",
        returns: "refused",
        directory: ONE,
      },
      { op: "get", key: "a", returns: hexOf("one"), directory: ONE },
    ],
  },
  {
    name: "a_key_under_a_file_or_naming_a_directory_is_an_error_not_absence",
    start: plus(ONE, NESTED),
    steps: [
      { op: "get", key: "a/b", returns: "error", directory: plus(ONE, NESTED) },
      { op: "get", key: "d", returns: "error", directory: plus(ONE, NESTED) },
      {
        op: "set",
        key: "a/b",
        value: "01",
        returns: "error",
        directory: plus(ONE, NESTED),
      },
      {
        op: "set",
        key: "d",
        value: "01",
        returns: "error",
        directory: plus(ONE, NESTED),
      },
      {
        op: "delete",
        key: "a/b",
        returns: "error",
        directory: plus(ONE, NESTED),
      },
    ],
  },
];

export function fileStorageFile(): {
  vectors: never[];
  extra: Record<string, JsonWire>;
} {
  const scenarios = SCENARIOS.map((scenario): JsonWire => ({
    name: scenario.name,
    start: sorted(scenario.start),
    steps: scenario.steps.map((step): JsonWire => {
      const directory = sorted(step.directory);
      if (step.op === "set") {
        return {
          op: step.op,
          key: step.key,
          value_hex: step.value,
          returns: step.returns,
          directory,
        };
      }
      if (step.op === "keys") {
        return {
          op: step.op,
          prefix: step.prefix,
          returns: [...step.returns],
          directory,
        };
      }

      return { op: step.op, key: step.key, returns: step.returns, directory };
    }),
  }));

  return {
    vectors: [],
    extra: {
      file_storage: {
        layout_version: FILE_STORAGE_LAYOUT_VERSION,
        key_layout: KEY_CASES.map((entry): JsonWire => ({
          name: entry.name,
          key: entry.key,
          expected: entry.expected,
        })),
        scenarios,
        counts: { key_layout: KEY_CASES.length, scenarios: SCENARIOS.length },
      },
    },
  };
}
