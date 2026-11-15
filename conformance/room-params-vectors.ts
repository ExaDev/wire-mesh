/* room-params.v1.json: the typed core/room and capability verbs and their outcomes (spec/room.cddl, spec/management.cddl), and the room-path and hex helpers they are addressed with.

   The top-level vectors are the manage-request and manage-response frames the cases use, round-tripped like any other file. The `room_params` section holds what a round trip cannot: for each frame, the shape it must decode to and the value of every field of it, written by hand from the spec; and a list of frames each breaking one rule of a shape, which a typed decoder must refuse (with the name of the valid frame it is a variation of). The `room_path` section holds the room-path and hex helper cases. Every outcome is written by hand from the spec, never produced by an implementation. Device-ids and tokens are structural bytes (a token is a well-formed COSE_Sign1 with a filler signature), as in the other vector files. */

import { hex, type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";
import { roomPathSection } from "./room-path-vectors.ts";
import { wireHex } from "./secure-channel-crypto.ts";

export const ROOM_PARAMS_LAYOUT_VERSION = 1;

const DEVICE_BYTES = 32;
/** One byte short of and one byte over a device-id, in hex. */
const SHORT_DEVICE_TEXT = "22".repeat(DEVICE_BYTES - 1);
const SIGNATURE_BYTES = 64;
const OWNER = "11".repeat(DEVICE_BYTES);
const DEVICE_B = "22".repeat(DEVICE_BYTES);
const DEVICE_C = "33".repeat(DEVICE_BYTES);
const ROOM = `${OWNER}/general`;
const TOKEN_PAYLOAD = "a1626964a0";
const TOKEN_SIGNATURE = "cc".repeat(SIGNATURE_BYTES);
const SENT_AT = 1_893_456_000_000;
const READ_AT = 1_893_456_005_000;
const DEADLINE = 1_893_459_600_000;
const LARGEST_EXACT = Number.MAX_SAFE_INTEGER;

/** A COSE_Sign1 of structural bytes: a well-formed envelope, not a token that verifies. */
const TOKEN: JsonWire = [
  hex("a0"),
  {},
  hex(TOKEN_PAYLOAD),
  hex(TOKEN_SIGNATURE),
];
const TOKEN_WIRE_HEX = wireHex(TOKEN);

const SCOPE: JsonWire = { kind: "room", path: ROOM };
const FOLDER_SCOPE: JsonWire = { kind: "folder", path: "/work" };

type Shape =
  | "room.send"
  | "room.read"
  | "room.leave"
  | "room.invite"
  | "capability.request"
  | "room-join-ok"
  | "room-members-ok"
  | "capability-grant-ok";

interface Typed {
  name: string;
  shape: Shape;
  /** The frame's request-id and its body: the params of a request or the outcome of a response. */
  body: JsonWire;
  /** The value of each field of the shape, and the keys of the open tail. */
  fields: JsonWire;
}

function isOutcome(shape: Shape): boolean {
  return shape.endsWith("-ok");
}

function frameOf(
  typed: { shape: Shape; body: JsonWire },
  id: number,
): JsonWire {
  if (isOutcome(typed.shape)) {
    return { type: "manage-response", "request-id": id, outcome: typed.body };
  }
  const capability = typed.shape === "capability.request";

  return {
    type: "manage-request",
    "request-id": id,
    command: {
      verb: capability ? "fs:read" : "room:member",
      params: typed.body,
    },
    scope: capability ? FOLDER_SCOPE : SCOPE,
  };
}

const MEMBER_B: JsonWire = { device: hex(DEVICE_B) };
const MEMBER_C_NAMED: JsonWire = { device: hex(DEVICE_C), name: "carol" };

const TYPED: readonly Typed[] = [
  {
    name: "room_send_minimal",
    shape: "room.send",
    body: {
      verb: "room.send",
      "message-id": hex("aa01"),
      "sent-at": SENT_AT,
      text: "hello",
    },
    fields: {
      message_id_hex: "aa01",
      sent_at: SENT_AT,
      text: "hello",
      content_type: null,
      refs: null,
      extra_keys: [],
    },
  },
  {
    name: "room_send_with_content_type_and_refs",
    shape: "room.send",
    body: {
      verb: "room.send",
      "message-id": hex("aa02"),
      "sent-at": SENT_AT,
      text: "sounds good",
      "content-type": "text/plain",
      refs: [
        { id: hex("aa00"), relation: "reply" },
        { id: hex("aa01"), relation: "forward" },
      ],
    },
    fields: {
      message_id_hex: "aa02",
      sent_at: SENT_AT,
      text: "sounds good",
      content_type: "text/plain",
      refs: [
        { id_hex: "aa00", relation: "reply" },
        { id_hex: "aa01", relation: "forward" },
      ],
      extra_keys: [],
    },
  },
  {
    name: "room_send_with_an_empty_refs_array",
    shape: "room.send",
    body: {
      verb: "room.send",
      "message-id": hex("aa03"),
      sent_at_hint: 1,
      "sent-at": SENT_AT,
      text: "",
      refs: [],
    },
    fields: {
      message_id_hex: "aa03",
      sent_at: SENT_AT,
      text: "",
      content_type: null,
      refs: [],
      extra_keys: ["sent_at_hint"],
    },
  },
  {
    name: "room_send_with_extension_keys_either_side_of_the_named_ones",
    shape: "room.send",
    body: {
      verb: "room.send",
      "message-id": hex("aa04"),
      "sent-at": SENT_AT,
      text: "urgent",
      ab: 1,
      "delivery-hint": { priority: "high", tags: ["a", "b"] },
    },
    fields: {
      message_id_hex: "aa04",
      sent_at: SENT_AT,
      text: "urgent",
      content_type: null,
      refs: null,
      extra_keys: ["ab", "delivery-hint"],
    },
  },
  {
    name: "room_send_with_the_largest_exact_sent_at",
    shape: "room.send",
    body: {
      verb: "room.send",
      "message-id": hex("aa01"),
      "sent-at": LARGEST_EXACT,
      text: "hello",
    },
    fields: {
      message_id_hex: "aa01",
      sent_at: LARGEST_EXACT,
      text: "hello",
      content_type: null,
      refs: null,
      extra_keys: [],
    },
  },
  {
    name: "room_read_with_the_largest_exact_at",
    shape: "room.read",
    body: { verb: "room.read", messages: [], at: LARGEST_EXACT },
    fields: { messages_hex: [], at: LARGEST_EXACT, extra_keys: [] },
  },
  {
    name: "capability_request_with_the_largest_exact_deadline",
    shape: "capability.request",
    body: {
      verb: "capability.request",
      capability: "fs:read",
      "valid-until": LARGEST_EXACT,
    },
    fields: {
      capability: "fs:read",
      valid_until: LARGEST_EXACT,
      extra_keys: [],
    },
  },
  {
    name: "room_read_two_messages",
    shape: "room.read",
    body: {
      verb: "room.read",
      messages: [hex("aa01"), hex("aa02")],
      at: READ_AT,
    },
    fields: { messages_hex: ["aa01", "aa02"], at: READ_AT, extra_keys: [] },
  },
  {
    name: "room_read_with_no_messages_and_an_extension",
    shape: "room.read",
    body: { verb: "room.read", messages: [], at: READ_AT, via: "batch" },
    fields: { messages_hex: [], at: READ_AT, extra_keys: ["via"] },
  },
  {
    name: "room_leave_bare",
    shape: "room.leave",
    body: { verb: "room.leave" },
    fields: { extra_keys: [] },
  },
  {
    name: "room_leave_with_extensions",
    shape: "room.leave",
    body: { verb: "room.leave", reason: "done", x: null },
    fields: { extra_keys: ["reason", "x"] },
  },
  {
    name: "room_invite",
    shape: "room.invite",
    body: { verb: "room.invite", invitee: hex(DEVICE_C), token: TOKEN },
    fields: {
      invitee_hex: DEVICE_C,
      token_wire_hex: TOKEN_WIRE_HEX,
      extra_keys: [],
    },
  },
  {
    name: "room_invite_with_an_extension",
    shape: "room.invite",
    body: {
      verb: "room.invite",
      invitee: hex(DEVICE_C),
      token: TOKEN,
      note: "welcome",
    },
    fields: {
      invitee_hex: DEVICE_C,
      token_wire_hex: TOKEN_WIRE_HEX,
      extra_keys: ["note"],
    },
  },
  {
    name: "capability_request",
    shape: "capability.request",
    body: { verb: "capability.request", capability: "fs:read" },
    fields: { capability: "fs:read", valid_until: null, extra_keys: [] },
  },
  {
    name: "capability_request_with_a_deadline",
    shape: "capability.request",
    body: {
      verb: "capability.request",
      capability: "fs:read",
      "valid-until": DEADLINE,
    },
    fields: { capability: "fs:read", valid_until: DEADLINE, extra_keys: [] },
  },
  {
    name: "capability_request_with_an_extension",
    shape: "capability.request",
    body: {
      verb: "capability.request",
      capability: "fs:read",
      why: "to read the report",
    },
    fields: { capability: "fs:read", valid_until: null, extra_keys: ["why"] },
  },
  {
    name: "room_join_ok",
    shape: "room-join-ok",
    body: {
      result: "ok",
      "granted-token": TOKEN,
      members: [MEMBER_B, MEMBER_C_NAMED],
    },
    fields: {
      granted_token_wire_hex: TOKEN_WIRE_HEX,
      members: [
        { device_hex: DEVICE_B, extra_keys: [] },
        { device_hex: DEVICE_C, extra_keys: ["name"] },
      ],
      extra_keys: [],
    },
  },
  {
    name: "room_join_ok_with_an_extension_and_no_members",
    shape: "room-join-ok",
    body: {
      result: "ok",
      "granted-token": TOKEN,
      members: [],
      welcome: "hi",
    },
    fields: {
      granted_token_wire_hex: TOKEN_WIRE_HEX,
      members: [],
      extra_keys: ["welcome"],
    },
  },
  {
    name: "room_members_ok",
    shape: "room-members-ok",
    body: { result: "ok", members: [MEMBER_B, MEMBER_C_NAMED] },
    fields: {
      members: [
        { device_hex: DEVICE_B, extra_keys: [] },
        { device_hex: DEVICE_C, extra_keys: ["name"] },
      ],
      extra_keys: [],
    },
  },
  {
    name: "room_members_ok_empty_with_an_extension",
    shape: "room-members-ok",
    body: { result: "ok", members: [], as_of: READ_AT },
    fields: { members: [], extra_keys: ["as_of"] },
  },
  {
    name: "capability_grant_ok",
    shape: "capability-grant-ok",
    body: { result: "ok", "granted-token": TOKEN },
    fields: { granted_token_wire_hex: TOKEN_WIRE_HEX, extra_keys: [] },
  },
  {
    name: "capability_grant_ok_with_an_extension",
    shape: "capability-grant-ok",
    body: { result: "ok", "granted-token": TOKEN, expires_hint: DEADLINE },
    fields: {
      granted_token_wire_hex: TOKEN_WIRE_HEX,
      extra_keys: ["expires_hint"],
    },
  },
];

interface Refused {
  name: string;
  /** The typed vector this is a variation of: the same shape with the one rule broken. */
  control: string;
  shape: Shape;
  body: JsonWire;
  /** The Rust decoder refuses the frame and the TypeScript schema accepts it, so only the Rust binary runs it. */
  rustOnly?: boolean;
  /** The body carries the largest exact integer exactly once, and the frame is written with the next integer in its place: JSON-shaped values cannot hold it. */
  beyondExact?: boolean;
}

const VALID_SEND = {
  verb: "room.send",
  "message-id": hex("aa01"),
  "sent-at": SENT_AT,
  text: "hello",
};

const REFUSED: readonly Refused[] = [
  {
    name: "room_send_without_text",
    control: "room_send_minimal",
    shape: "room.send",
    body: {
      verb: "room.send",
      "message-id": hex("aa01"),
      "sent-at": SENT_AT,
    },
  },
  {
    name: "room_send_with_text_as_an_integer",
    control: "room_send_minimal",
    shape: "room.send",
    body: { ...VALID_SEND, text: 1 },
  },
  {
    name: "room_send_with_a_message_id_as_text",
    control: "room_send_minimal",
    shape: "room.send",
    body: { ...VALID_SEND, "message-id": "aa01" },
  },
  {
    name: "room_send_with_a_sent_at_beyond_the_exact_range",
    control: "room_send_with_the_largest_exact_sent_at",
    shape: "room.send",
    body: { ...VALID_SEND, "sent-at": LARGEST_EXACT },
    beyondExact: true,
  },
  {
    name: "room_read_with_an_at_beyond_the_exact_range",
    control: "room_read_with_the_largest_exact_at",
    shape: "room.read",
    body: { verb: "room.read", messages: [], at: LARGEST_EXACT },
    beyondExact: true,
  },
  {
    name: "capability_request_with_a_deadline_beyond_the_exact_range",
    control: "capability_request_with_the_largest_exact_deadline",
    shape: "capability.request",
    body: {
      verb: "capability.request",
      capability: "fs:read",
      "valid-until": LARGEST_EXACT,
    },
    beyondExact: true,
  },
  {
    name: "room_send_with_a_negative_sent_at",
    control: "room_send_minimal",
    shape: "room.send",
    body: { ...VALID_SEND, "sent-at": -1 },
  },
  {
    name: "room_send_with_refs_that_is_not_an_array",
    control: "room_send_with_content_type_and_refs",
    shape: "room.send",
    body: { ...VALID_SEND, refs: { id: hex("aa00"), relation: "reply" } },
  },
  {
    name: "room_send_with_a_ref_that_carries_a_key_the_rule_does_not_name",
    control: "room_send_with_content_type_and_refs",
    shape: "room.send",
    body: {
      ...VALID_SEND,
      refs: [{ id: hex("aa00"), relation: "reply", via: "forward" }],
    },
    rustOnly: true,
  },
  {
    name: "room_send_with_a_ref_without_a_relation",
    control: "room_send_with_content_type_and_refs",
    shape: "room.send",
    body: { ...VALID_SEND, refs: [{ id: hex("aa00") }] },
  },
  {
    name: "room_send_with_a_content_type_that_is_not_text",
    control: "room_send_with_content_type_and_refs",
    shape: "room.send",
    body: { ...VALID_SEND, "content-type": hex("aa") },
  },
  {
    name: "room_read_with_a_message_as_text",
    control: "room_read_two_messages",
    shape: "room.read",
    body: { verb: "room.read", messages: ["aa01"], at: READ_AT },
  },
  {
    name: "room_read_without_at",
    control: "room_read_two_messages",
    shape: "room.read",
    body: { verb: "room.read", messages: [hex("aa01")] },
  },
  {
    name: "room_read_with_messages_that_is_not_an_array",
    control: "room_read_two_messages",
    shape: "room.read",
    body: { verb: "room.read", messages: hex("aa01"), at: READ_AT },
  },
  {
    name: "room_invite_with_an_invitee_of_the_wrong_length",
    control: "room_invite",
    shape: "room.invite",
    body: {
      verb: "room.invite",
      invitee: hex(SHORT_DEVICE_TEXT),
      token: TOKEN,
    },
  },
  {
    name: "room_invite_without_a_token",
    control: "room_invite",
    shape: "room.invite",
    body: { verb: "room.invite", invitee: hex(DEVICE_C) },
  },
  {
    name: "room_invite_with_a_token_that_is_not_a_cose_sign1",
    control: "room_invite",
    shape: "room.invite",
    body: {
      verb: "room.invite",
      invitee: hex(DEVICE_C),
      token: hex(TOKEN_PAYLOAD),
    },
  },
  {
    name: "capability_request_without_a_capability",
    control: "capability_request",
    shape: "capability.request",
    body: { verb: "capability.request" },
  },
  {
    name: "capability_request_with_a_capability_that_is_not_text",
    control: "capability_request",
    shape: "capability.request",
    body: { verb: "capability.request", capability: 7 },
  },
  {
    name: "capability_request_with_a_negative_deadline",
    control: "capability_request_with_a_deadline",
    shape: "capability.request",
    body: {
      verb: "capability.request",
      capability: "fs:read",
      "valid-until": -1,
    },
  },
  {
    name: "room_join_ok_without_members",
    control: "room_join_ok",
    shape: "room-join-ok",
    body: { result: "ok", "granted-token": TOKEN },
  },
  {
    name: "room_join_ok_without_a_token",
    control: "room_join_ok",
    shape: "room-join-ok",
    body: { result: "ok", members: [MEMBER_B] },
  },
  {
    name: "room_join_ok_with_a_member_without_a_device",
    control: "room_join_ok",
    shape: "room-join-ok",
    body: {
      result: "ok",
      "granted-token": TOKEN,
      members: [{ name: "nobody" }],
    },
  },
  {
    name: "room_members_ok_with_members_that_is_not_an_array",
    control: "room_members_ok",
    shape: "room-members-ok",
    body: { result: "ok", members: MEMBER_B },
  },
  {
    name: "room_members_ok_with_a_device_of_the_wrong_length",
    control: "room_members_ok",
    shape: "room-members-ok",
    body: { result: "ok", members: [{ device: hex(SHORT_DEVICE_TEXT) }] },
  },
  {
    name: "capability_grant_ok_without_a_token",
    control: "capability_grant_ok",
    shape: "capability-grant-ok",
    body: { result: "ok" },
  },
  {
    name: "capability_grant_ok_with_a_token_that_is_not_a_cose_sign1",
    control: "capability_grant_ok",
    shape: "capability-grant-ok",
    body: { result: "ok", "granted-token": hex(TOKEN_PAYLOAD) },
  },
];

const LARGEST_EXACT_HEAD = "1b001fffffffffffff";
const NEXT_INTEGER_HEAD = "1b0020000000000000";

/** The wire of a refused frame; for a `beyondExact` entry the one 2^53 - 1 in it becomes 2^53, written as the same eight-byte head. */
function refusedWireHex(entry: Refused): string {
  const wire = wireHex(frameOf(entry, 1));
  if (entry.beyondExact !== true) {
    return wire;
  }
  if (wire.split(LARGEST_EXACT_HEAD).length !== 2) {
    throw new Error(`${entry.name} must hold the largest exact integer once`);
  }

  return wire.replace(LARGEST_EXACT_HEAD, NEXT_INTEGER_HEAD);
}

export function roomParamsFile(): {
  vectors: Vector[];
  extra: Record<string, JsonWire>;
} {
  const vectors: Vector[] = [];
  const names = new Set(TYPED.map((entry) => entry.name));
  let id = 0;
  const frames = new Map<string, number>();
  for (const entry of TYPED) {
    id += 1;
    frames.set(entry.name, id);
    const message = frameOf(entry, id);
    vectors.push({
      name: entry.name,
      message,
      wire_hex: wireHex(message),
    });
  }
  const typed = TYPED.map((entry): JsonWire => ({
    vector: entry.name,
    shape: entry.shape,
    fields: entry.fields,
  }));
  const refused = REFUSED.map((entry): JsonWire => {
    if (!names.has(entry.control)) {
      throw new Error(`${entry.name} names a control that is not a vector`);
    }
    const control = TYPED.find(
      (typedEntry) => typedEntry.name === entry.control,
    );
    if (control?.shape !== entry.shape) {
      throw new Error(`${entry.name} and its control are not the same shape`);
    }

    return {
      name: entry.name,
      shape: entry.shape,
      control: entry.control,
      rust_only: entry.rustOnly ?? false,
      frame_wire_hex: refusedWireHex(entry),
    };
  });

  const path = roomPathSection();

  return {
    vectors,
    extra: {
      room_params: {
        layout_version: ROOM_PARAMS_LAYOUT_VERSION,
        typed,
        refused,
        room_path: path.section,
        counts: {
          typed: TYPED.length,
          refused: REFUSED.length,
          ...path.counts,
        },
      },
    },
  };
}
