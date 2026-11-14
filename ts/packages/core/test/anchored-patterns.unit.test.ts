// Every string pattern in spec/*.cddl (`.regexp`) matches the WHOLE string, as XSD patterns do, and the schemas generated from them must too: Zod's `.regex()` is a substring test, so a pattern that is not anchored accepts any value that merely contains a match. Each case below pairs a value the CDDL accepts with one that only an unanchored match accepts, and the frame cases go through the real frame decoder, since that is where a peer's bytes arrive.

import { describe, expect, it } from "vitest";
import {
  messageFromFrame,
  tryDecodeFrame,
} from "../src/adapters/frame-codec.js";
import {
  capabilityVerbSchema,
  coreCapabilitySchema,
  deviceIdHexSchema,
  dmRoomPathSchema,
  namespacedCapabilitySchema,
  namespacedDomainIdSchema,
  ownerNamedRoomPathSchema,
  privateUseCapabilitySchema,
  privateUseDomainIdSchema,
} from "../src/generated/protocol.js";

const DEVICE_ID_BYTES = 32;
const HEX_64 = "ab".repeat(DEVICE_ID_BYTES);

const patterns: readonly {
  name: string;
  schema: { safeParse: (value: unknown) => { success: boolean } };
  valid: string;
  onlyUnanchoredAccepts: readonly string[];
}[] = [
  {
    name: "core-capability",
    schema: coreCapabilitySchema,
    valid: "exec:pty",
    onlyUnanchoredAccepts: [
      "two:colons:here",
      "exec:pty extra",
      "-x:pty",
      "exec:pty\n",
    ],
  },
  {
    name: "namespaced-capability",
    schema: namespacedCapabilitySchema,
    valid: "example.com/tool:run",
    onlyUnanchoredAccepts: [
      "example.com/tool:run:more",
      "!example.com/tool:run",
      "example.com/tool:run extra",
    ],
  },
  {
    name: "private-use-capability",
    schema: privateUseCapabilitySchema,
    valid: "x-local:run",
    onlyUnanchoredAccepts: [
      "x-local:run extra",
      "prefix x-local:run",
      "x-local:run:more",
    ],
  },
  {
    name: "namespaced-domain-id",
    schema: namespacedDomainIdSchema,
    valid: "example.com/thing",
    onlyUnanchoredAccepts: [
      "example.com/thing extra",
      "!example.com/thing",
      "example.com/thing\n",
    ],
  },
  {
    name: "private-use-domain-id",
    schema: privateUseDomainIdSchema,
    valid: "x-thing",
    onlyUnanchoredAccepts: ["x-thing extra", "prefix x-thing", "x-thing/more"],
  },
  {
    name: "device-id-hex",
    schema: deviceIdHexSchema,
    valid: HEX_64,
    onlyUnanchoredAccepts: [
      `${HEX_64}0`,
      `0${HEX_64}`,
      `${HEX_64} `,
      `${HEX_64}\n`,
    ],
  },
  {
    name: "owner-named-room-path",
    schema: ownerNamedRoomPathSchema,
    valid: `${HEX_64}/general`,
    onlyUnanchoredAccepts: [
      `${HEX_64}/general extra`,
      `0${HEX_64}/general`,
      `${HEX_64}/general/more`,
    ],
  },
  {
    name: "dm-room-path",
    schema: dmRoomPathSchema,
    valid: `${HEX_64}+${HEX_64}`,
    onlyUnanchoredAccepts: [
      `${HEX_64}+${HEX_64}0`,
      `0${HEX_64}+${HEX_64}`,
      `${HEX_64}+${HEX_64}+${HEX_64}`,
    ],
  },
];

describe("generated string patterns match the whole value", () => {
  for (const pattern of patterns) {
    it(`${pattern.name} accepts its own grammar`, () => {
      expect(pattern.schema.safeParse(pattern.valid).success).toBe(true);
    });
    for (const value of pattern.onlyUnanchoredAccepts) {
      it(`${pattern.name} refuses ${JSON.stringify(value)}`, () => {
        expect(pattern.schema.safeParse(value).success).toBe(false);
      });
    }
  }

  // Characters a character class or a line-anchored pattern could let through: an astral character (one code point, two UTF-16 units), a lone surrogate, every line terminator and NUL, before, after and inside a valid value.
  const OTHER_CHARACTERS = [
    "\u{1F600}",
    "\uD800",
    "\r",
    "\u2028",
    "\u2029",
    "\u0085",
    "\0",
  ];
  for (const pattern of patterns) {
    for (const character of OTHER_CHARACTERS) {
      it(`${pattern.name} refuses ${JSON.stringify(character)} around and inside a valid value`, () => {
        const middle = Math.floor(pattern.valid.length / 2);
        for (const value of [
          pattern.valid + character,
          character + pattern.valid,
          pattern.valid.slice(0, middle) +
            character +
            pattern.valid.slice(middle),
        ]) {
          expect(
            pattern.schema.safeParse(value).success,
            JSON.stringify(value),
          ).toBe(false);
        }
      });
    }
  }

  it("capability-verb refuses a value only a substring match accepts", () => {
    expect(capabilityVerbSchema.safeParse("two:colons:here").success).toBe(
      false,
    );
    expect(capabilityVerbSchema.safeParse("exec:pty").success).toBe(true);
  });
});

function manageRequest(verb: string): ReturnType<typeof messageFromFrame> {
  return messageFromFrame({
    type: "manage-request",
    "request-id": 1,
    command: { verb, params: { verb: "exec.list" } },
    scope: { kind: "folder" },
  });
}

describe("the frame decoder refuses a value only an unanchored pattern accepts", () => {
  for (const verb of [
    "two:colons:here",
    "exec:pty extra",
    "-x:pty",
    "example.com/tool:run:more",
    "x-local:run extra",
  ]) {
    it(`a manage-request carrying the verb ${JSON.stringify(verb)}`, () => {
      expect(tryDecodeFrame(manageRequest(verb))).toBeNull();
    });
  }

  it("still decodes the same manage-request with a valid verb", () => {
    expect(tryDecodeFrame(manageRequest("exec:proc"))?.type).toBe(
      "manage-request",
    );
  });

  for (const domain of [
    "example.com/thing extra",
    "x-thing extra",
    "!example.com/thing",
  ]) {
    it(`a handshake offering the domain ${JSON.stringify(domain)}`, () => {
      expect(
        tryDecodeFrame(
          messageFromFrame({
            type: "handshake",
            version: 1,
            domains: [domain],
          }),
        ),
      ).toBeNull();
    });
  }
});
