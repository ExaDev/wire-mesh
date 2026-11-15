import type { JsonWire } from "@exadev/wire-mesh-conformance";

/* The room-path and hex helper cases of room-params.v1.json: every outcome is written by hand from the spec, never produced by an implementation. */

const DEVICE_BYTES = 32;
const LONG_DEVICE_TEXT = "22".repeat(DEVICE_BYTES + 1);
const OWNER = "11".repeat(DEVICE_BYTES);
const DEVICE_B = "22".repeat(DEVICE_BYTES);
const DEVICE_C = "33".repeat(DEVICE_BYTES);
const ROOM = `${OWNER}/general`;

/** The room-path and hex helper cases. */
const HEX_CASES: readonly {
  name: string;
  bytes_hex: string;
}[] = [
  { name: "no_bytes", bytes_hex: "" },
  { name: "one_byte", bytes_hex: "0a" },
  { name: "every_digit", bytes_hex: "0123456789abcdef" },
  { name: "a_device_id", bytes_hex: "ab".repeat(DEVICE_BYTES) },
];

const HEX_REFUSED: readonly { name: string; text: string }[] = [
  { name: "an_odd_length", text: "abc" },
  { name: "an_uppercase_digit", text: "AB" },
  { name: "a_character_that_is_not_hex", text: "zz" },
  { name: "a_space", text: "ab " },
  { name: "a_trailing_newline", text: "ab\n" },
  { name: "a_non_ascii_digit", text: "١٢" },
];

type PathExpected = { path: string } | { error: string };

const OWNER_NAMED: readonly {
  name: string;
  owner: string;
  local_name: string;
  expected: PathExpected;
}[] = [
  {
    name: "a_plain_name",
    owner: OWNER,
    local_name: "general",
    expected: { path: `${OWNER}/general` },
  },
  {
    name: "every_allowed_character",
    owner: OWNER,
    local_name: "aZ09_-",
    expected: { path: `${OWNER}/aZ09_-` },
  },
  {
    name: "an_uppercase_owner",
    owner: OWNER.toUpperCase().replace(/1/g, "A"),
    local_name: "general",
    expected: { error: "not_device_id_hex" },
  },
  {
    name: "an_owner_of_the_wrong_length",
    owner: "11".repeat(DEVICE_BYTES - 1),
    local_name: "general",
    expected: { error: "not_device_id_hex" },
  },
  {
    name: "an_empty_name",
    owner: OWNER,
    local_name: "",
    expected: { error: "not_local_name" },
  },
  {
    name: "a_name_with_a_slash",
    owner: OWNER,
    local_name: "a/b",
    expected: { error: "not_local_name" },
  },
  {
    name: "a_name_with_a_space",
    owner: OWNER,
    local_name: "a b",
    expected: { error: "not_local_name" },
  },
  {
    name: "a_name_with_a_trailing_newline",
    owner: OWNER,
    local_name: "general\n",
    expected: { error: "not_local_name" },
  },
  {
    name: "a_name_with_a_non_ascii_letter",
    owner: OWNER,
    local_name: "café",
    expected: { error: "not_local_name" },
  },
  {
    name: "a_bad_owner_is_named_before_a_bad_name",
    owner: "xyz",
    local_name: "",
    expected: { error: "not_device_id_hex" },
  },
];

const DM: readonly {
  name: string;
  a: string;
  b: string;
  expected: PathExpected;
}[] = [
  {
    name: "already_in_order",
    a: OWNER,
    b: DEVICE_B,
    expected: { path: `${OWNER}+${DEVICE_B}` },
  },
  {
    name: "sorted_whichever_way_they_are_given",
    a: DEVICE_B,
    b: OWNER,
    expected: { path: `${OWNER}+${DEVICE_B}` },
  },
  {
    name: "ordered_by_the_first_differing_digit",
    a: `${"00".repeat(DEVICE_BYTES - 1)}ff`,
    b: `${"00".repeat(DEVICE_BYTES - 1)}0f`,
    expected: {
      path: `${"00".repeat(DEVICE_BYTES - 1)}0f+${"00".repeat(DEVICE_BYTES - 1)}ff`,
    },
  },
  {
    name: "the_same_device_twice",
    a: OWNER,
    b: OWNER,
    expected: { error: "same_device" },
  },
  {
    name: "a_first_device_that_is_not_hex",
    a: "nope",
    b: OWNER,
    expected: { error: "not_device_id_hex" },
  },
  {
    name: "a_second_device_of_the_wrong_length",
    a: OWNER,
    b: LONG_DEVICE_TEXT,
    expected: { error: "not_device_id_hex" },
  },
  {
    name: "a_bad_device_is_named_before_the_same_device",
    a: "nope",
    b: "nope",
    expected: { error: "not_device_id_hex" },
  },
];

type ParsedExpected =
  | { kind: "owner_named"; owner: string; local_name: string }
  | { kind: "dm"; first: string; second: string }
  | { error: string };

const PARSE: readonly {
  name: string;
  path: string;
  expected: ParsedExpected;
}[] = [
  {
    name: "an_owner_named_path",
    path: ROOM,
    expected: { kind: "owner_named", owner: OWNER, local_name: "general" },
  },
  {
    name: "a_dm_path",
    path: `${OWNER}+${DEVICE_B}`,
    expected: { kind: "dm", first: OWNER, second: DEVICE_B },
  },
  {
    name: "a_dm_path_out_of_order_is_read_as_given",
    path: `${DEVICE_B}+${OWNER}`,
    expected: { kind: "dm", first: DEVICE_B, second: OWNER },
  },
  {
    name: "the_empty_string",
    path: "",
    expected: { error: "not_a_room_path" },
  },
  {
    name: "a_leading_space",
    path: ` ${ROOM}`,
    expected: { error: "not_a_room_path" },
  },
  {
    name: "a_trailing_newline",
    path: `${ROOM}\n`,
    expected: { error: "not_a_room_path" },
  },
  {
    name: "a_second_slash",
    path: `${ROOM}/more`,
    expected: { error: "not_a_room_path" },
  },
  {
    name: "no_name",
    path: `${OWNER}/`,
    expected: { error: "not_a_room_path" },
  },
  {
    name: "an_uppercase_owner",
    path: `${OWNER.replace(/1/g, "A")}/general`,
    expected: { error: "not_a_room_path" },
  },
  {
    name: "a_dm_of_the_same_device",
    path: `${OWNER}+${OWNER}`,
    expected: { error: "not_a_room_path" },
  },
  {
    name: "a_dm_with_a_third_device",
    path: `${OWNER}+${DEVICE_B}+${DEVICE_C}`,
    expected: { error: "not_a_room_path" },
  },
  {
    name: "a_dm_with_a_trailing_newline",
    path: `${OWNER}+${DEVICE_B}\n`,
    expected: { error: "not_a_room_path" },
  },
  {
    name: "neither_shape",
    path: "not-a-room-path",
    expected: { error: "not_a_room_path" },
  },
];

const SLUG: readonly {
  name: string;
  input: string;
  expected: { slug: string } | { error: string };
}[] = [
  {
    name: "an_already_valid_name",
    input: "my-room_1",
    expected: { slug: "my-room_1" },
  },
  {
    name: "a_space_becomes_a_hyphen",
    input: "my room",
    expected: { slug: "my-room" },
  },
  {
    name: "a_run_becomes_one_hyphen",
    input: "my  /  room",
    expected: { slug: "my-room" },
  },
  {
    name: "hyphens_at_either_end_are_trimmed",
    input: "--my room--",
    expected: { slug: "my-room" },
  },
  {
    name: "invalid_characters_at_either_end_are_trimmed",
    input: "  my room  ",
    expected: { slug: "my-room" },
  },
  {
    name: "a_non_ascii_letter_is_replaced",
    input: "café au lait",
    expected: { slug: "caf-au-lait" },
  },
  {
    name: "a_character_outside_the_basic_plane_is_one_run",
    input: "a\u{1f600}b",
    expected: { slug: "a-b" },
  },
  { name: "underscores_are_kept", input: "_a_", expected: { slug: "_a_" } },
  { name: "an_empty_name", input: "", expected: { error: "nothing_to_slug" } },
  {
    name: "only_hyphens",
    input: "---",
    expected: { error: "nothing_to_slug" },
  },
  {
    name: "only_invalid_characters",
    input: "éè !",
    expected: { error: "nothing_to_slug" },
  },
];

/** The `room_path` section and the number of entries in each of its lists. */
export function roomPathSection(): {
  section: JsonWire;
  counts: Record<string, number>;
} {
  return {
    section: {
      bytes: HEX_CASES.map((entry) => ({ ...entry })),
      bytes_refused: HEX_REFUSED.map((entry) => ({ ...entry })),
      owner_named: OWNER_NAMED.map((entry) => ({ ...entry })),
      dm: DM.map((entry) => ({ ...entry })),
      parse: PARSE.map((entry) => ({ ...entry })),
      slug: SLUG.map((entry) => ({ ...entry })),
    },
    counts: {
      bytes: HEX_CASES.length,
      bytes_refused: HEX_REFUSED.length,
      owner_named: OWNER_NAMED.length,
      dm: DM.length,
      parse: PARSE.length,
      slug: SLUG.length,
    },
  };
}
