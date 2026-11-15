/* Checks every case of conformance/room-params.v1.json against the real schemas and helpers. The schemas below are strict, so a key this test does not read fails it. In summary:

   - each typed frame is decoded as a frame and its params or outcome is read through the schema of the shape the file names, and every field and the keys of the open tail are compared with the file;
   - each frame that breaks a rule of a shape is refused by that shape's schema, and the valid frame it varies is accepted;
   - each room-path and hex helper case gives the value the file states, and a refusal is a thrown error (the TypeScript helpers report a refusal as a message, so the named reason is checked by the Rust binary);
   - every list holds the number of entries the file's header says.

   Not compared, because they only name: every `name`, and the layout version (checked to be the one this test reads). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import { bytesFromHex, bytesToHex } from "../src/domain/device-id.js";
import {
  dmRoomPath,
  ownerNamedRoomPath,
  parseRoomPath,
  slugRoomName,
} from "../src/domain/room-path.js";
import {
  capabilityGrantOkSchema,
  capabilityRequestSchema,
  frameSchema,
  roomInviteSchema,
  roomJoinOkSchema,
  roomLeaveSchema,
  roomMembersOkSchema,
  roomReadSchema,
  roomSendSchema,
} from "../src/generated/protocol.js";
import { bytesFromHex as testBytesFromHex } from "./hex.js";

const LAYOUT_VERSION = 1;
const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/);
const SHAPES = [
  "room.send",
  "room.read",
  "room.leave",
  "room.invite",
  "capability.request",
  "room-join-ok",
  "room-members-ok",
  "capability-grant-ok",
] as const;
type Shape = (typeof SHAPES)[number];
const shapeName = z.enum(SHAPES);

const pathExpected = z.union([
  z.strictObject({ path: z.string() }),
  z.strictObject({ error: z.string() }),
]);

const file = z
  .object({
    vectors: z.array(z.object({ name: z.string(), wire_hex: hexString })),
    room_params: z.strictObject({
      layout_version: z.literal(LAYOUT_VERSION),
      typed: z.array(
        z.strictObject({
          vector: z.string(),
          shape: shapeName,
          fields: z.record(z.string(), z.unknown()),
        }),
      ),
      refused: z.array(
        z.strictObject({
          name: z.string(),
          shape: shapeName,
          control: z.string(),
          rust_only: z.boolean(),
          frame_wire_hex: hexString,
        }),
      ),
      room_path: z.strictObject({
        bytes: z.array(
          z.strictObject({ name: z.string(), bytes_hex: hexString }),
        ),
        bytes_refused: z.array(
          z.strictObject({ name: z.string(), text: z.string() }),
        ),
        owner_named: z.array(
          z.strictObject({
            name: z.string(),
            owner: z.string(),
            local_name: z.string(),
            expected: pathExpected,
          }),
        ),
        dm: z.array(
          z.strictObject({
            name: z.string(),
            a: z.string(),
            b: z.string(),
            expected: pathExpected,
          }),
        ),
        parse: z.array(
          z.strictObject({
            name: z.string(),
            path: z.string(),
            expected: z.union([
              z.strictObject({
                kind: z.literal("owner_named"),
                owner: z.string(),
                local_name: z.string(),
              }),
              z.strictObject({
                kind: z.literal("dm"),
                first: z.string(),
                second: z.string(),
              }),
              z.strictObject({ error: z.string() }),
            ]),
          }),
        ),
        slug: z.array(
          z.strictObject({
            name: z.string(),
            input: z.string(),
            expected: z.union([
              z.strictObject({ slug: z.string() }),
              z.strictObject({ error: z.string() }),
            ]),
          }),
        ),
      }),
      counts: z.strictObject({
        typed: z.number().int(),
        refused: z.number().int(),
        bytes: z.number().int(),
        bytes_refused: z.number().int(),
        owner_named: z.number().int(),
        dm: z.number().int(),
        parse: z.number().int(),
        slug: z.number().int(),
      }),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../conformance/room-params.v1.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ),
  );
const section = file.room_params;

function wireOf(name: string): Uint8Array {
  const found = file.vectors.find((vector) => vector.name === name);
  if (found === undefined) {
    throw new Error(`vector file has no vector ${name}`);
  }

  return testBytesFromHex(found.wire_hex);
}

/** The params of a request or the outcome of a response, as the decoded CBOR holds it, before any shape reads it. */
function bodyOf(wire: Uint8Array): unknown {
  const frame = z
    .object({
      command: z.object({ params: z.unknown() }).optional(),
      outcome: z.unknown().optional(),
    })
    .parse(decode(wire, cdeDecodeOptions));

  return frame.command === undefined ? frame.outcome : frame.command.params;
}

const KNOWN_KEYS: Readonly<Record<Shape, readonly string[]>> = {
  "room.send": [
    "verb",
    "message-id",
    "sent-at",
    "text",
    "content-type",
    "refs",
  ],
  "room.read": ["verb", "messages", "at"],
  "room.leave": ["verb"],
  "room.invite": ["verb", "invitee", "token"],
  "capability.request": ["verb", "capability", "valid-until"],
  "room-join-ok": ["result", "granted-token", "members"],
  "room-members-ok": ["result", "members"],
  "capability-grant-ok": ["result", "granted-token"],
};

const SCHEMAS = {
  "room.send": roomSendSchema,
  "room.read": roomReadSchema,
  "room.leave": roomLeaveSchema,
  "room.invite": roomInviteSchema,
  "capability.request": capabilityRequestSchema,
  "room-join-ok": roomJoinOkSchema,
  "room-members-ok": roomMembersOkSchema,
  "capability-grant-ok": capabilityGrantOkSchema,
} as const satisfies Record<Shape, z.ZodType>;

function extraKeys(shape: Shape, value: object): string[] {
  return Object.keys(value)
    .filter((key) => !KNOWN_KEYS[shape].includes(key))
    .sort();
}

const hexOf = (bytes: Uint8Array): string => bytesToHex(bytes);

/** The wire bytes of a token as the file records it, in hex: the structural COSE_Sign1 re-encoded canonically. */
function tokenHex(token: unknown): string {
  return Buffer.from(encode(token, cdeEncodeOptions)).toString("hex");
}

describe("the file's own accounting", () => {
  it("holds the number of entries its header says", () => {
    expect(section.typed).toHaveLength(section.counts.typed);
    expect(section.refused).toHaveLength(section.counts.refused);
    expect(section.room_path.bytes).toHaveLength(section.counts.bytes);
    expect(section.room_path.bytes_refused).toHaveLength(
      section.counts.bytes_refused,
    );
    expect(section.room_path.owner_named).toHaveLength(
      section.counts.owner_named,
    );
    expect(section.room_path.dm).toHaveLength(section.counts.dm);
    expect(section.room_path.parse).toHaveLength(section.counts.parse);
    expect(section.room_path.slug).toHaveLength(section.counts.slug);
  });

  it("has a typed vector for every shape, and a refused one for each", () => {
    for (const shape of SHAPES) {
      expect(
        section.typed.some((entry) => entry.shape === shape),
        shape,
      ).toBe(true);
    }
    for (const entry of section.refused) {
      const control = section.typed.find(
        (typed) => typed.vector === entry.control,
      );
      expect(control?.shape, entry.name).toBe(entry.shape);
    }
  });
});

describe("a typed frame", () => {
  for (const entry of section.typed) {
    it(`${entry.vector} is read as ${entry.shape}`, () => {
      const wire = wireOf(entry.vector);
      expect(
        frameSchema.safeParse(decode(wire, cdeDecodeOptions)).success,
      ).toBe(true);
      const parsed = SCHEMAS[entry.shape].parse(bodyOf(wire));
      expect(extraKeys(entry.shape, parsed)).toEqual(
        z.array(z.string()).parse(entry.fields.extra_keys).sort(),
      );
      const { extra_keys: expectedKeys, ...expected } = entry.fields;
      expect(expectedKeys).toBeDefined();
      expect(project(entry.shape, parsed)).toEqual(expected);
    });
  }
});

/** Every field of a shape except the open tail, in the form the file records it. */
function project(shape: Shape, parsed: unknown): Record<string, unknown> {
  if (shape === "room.send") {
    const value = roomSendSchema.parse(parsed);

    return {
      message_id_hex: hexOf(value["message-id"]),
      sent_at: value["sent-at"],
      text: value.text,
      content_type: value["content-type"] ?? null,
      refs:
        value.refs?.map((ref) => ({
          id_hex: hexOf(ref.id),
          relation: ref.relation,
        })) ?? null,
    };
  }
  if (shape === "room.read") {
    const value = roomReadSchema.parse(parsed);

    return {
      messages_hex: value.messages.map(hexOf),
      at: value.at,
    };
  }
  if (shape === "room.leave") {
    return {};
  }
  if (shape === "room.invite") {
    const value = roomInviteSchema.parse(parsed);

    return {
      invitee_hex: hexOf(value.invitee),
      token_wire_hex: tokenHex(value.token),
    };
  }
  if (shape === "capability.request") {
    const value = capabilityRequestSchema.parse(parsed);

    return {
      capability: value.capability,
      valid_until: value["valid-until"] ?? null,
    };
  }
  if (shape === "room-join-ok") {
    const value = roomJoinOkSchema.parse(parsed);

    return {
      granted_token_wire_hex: tokenHex(value["granted-token"]),
      members: value.members.map(memberProjection),
    };
  }
  if (shape === "room-members-ok") {
    const value = roomMembersOkSchema.parse(parsed);

    return {
      members: value.members.map(memberProjection),
    };
  }
  const value = capabilityGrantOkSchema.parse(parsed);

  return {
    granted_token_wire_hex: tokenHex(value["granted-token"]),
    extra_keys: undefined,
  };
}

function memberProjection(member: {
  device: Uint8Array;
}): Record<string, unknown> {
  return {
    device_hex: hexOf(member.device),
    extra_keys: Object.keys(member)
      .filter((key) => key !== "device")
      .sort(),
  };
}

describe("a frame that breaks a rule of its shape", () => {
  for (const entry of section.refused.filter((held) => !held.rust_only)) {
    it(`${entry.name} is refused as ${entry.shape}`, () => {
      const body = bodyOf(testBytesFromHex(entry.frame_wire_hex));
      expect(SCHEMAS[entry.shape].safeParse(body).success).toBe(false);
      const control = section.typed.find(
        (typed) => typed.vector === entry.control,
      );
      expect(control).toBeDefined();
      expect(
        SCHEMAS[entry.shape].safeParse(bodyOf(wireOf(entry.control))).success,
      ).toBe(true);
    });
  }
});

describe("the hex helpers", () => {
  for (const entry of section.room_path.bytes) {
    it(`round-trip ${entry.name}`, () => {
      const bytes = bytesFromHex(entry.bytes_hex);
      expect(bytesToHex(bytes)).toBe(entry.bytes_hex);
    });
  }
  for (const entry of section.room_path.bytes_refused) {
    it(`refuse ${entry.name}`, () => {
      expect(() => bytesFromHex(entry.text)).toThrow();
    });
  }
});

describe("the room-path helpers", () => {
  for (const entry of section.room_path.owner_named) {
    it(`ownerNamedRoomPath: ${entry.name}`, () => {
      if ("path" in entry.expected) {
        expect(ownerNamedRoomPath(entry.owner, entry.local_name)).toBe(
          entry.expected.path,
        );
      } else {
        expect(() =>
          ownerNamedRoomPath(entry.owner, entry.local_name),
        ).toThrow();
      }
    });
  }
  for (const entry of section.room_path.dm) {
    it(`dmRoomPath: ${entry.name}`, () => {
      if ("path" in entry.expected) {
        expect(dmRoomPath(entry.a, entry.b)).toBe(entry.expected.path);
      } else {
        expect(() => dmRoomPath(entry.a, entry.b)).toThrow();
      }
    });
  }
  for (const entry of section.room_path.parse) {
    it(`parseRoomPath: ${entry.name}`, () => {
      const expected = entry.expected;
      if ("error" in expected) {
        expect(() => parseRoomPath(entry.path)).toThrow();
      } else if (expected.kind === "owner_named") {
        expect(parseRoomPath(entry.path)).toEqual({
          kind: "owner-named",
          owner: expected.owner,
          localName: expected.local_name,
        });
      } else {
        expect(parseRoomPath(entry.path)).toEqual({
          kind: "dm",
          participants: [expected.first, expected.second],
        });
      }
    });
  }
  for (const entry of section.room_path.slug) {
    it(`slugRoomName: ${entry.name}`, () => {
      if ("slug" in entry.expected) {
        expect(slugRoomName(entry.input)).toBe(entry.expected.slug);
      } else {
        expect(() => slugRoomName(entry.input)).toThrow();
      }
    });
  }
});
