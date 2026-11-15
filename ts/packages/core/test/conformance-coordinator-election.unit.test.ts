/* Checks every scenario of conformance/coordinator-election.v1.json against the real CoordinatorElection, isSupersedableTerm and compareDeviceIds. The schemas are strict, so a key this test does not read fails it. In summary:

   - each scenario starts a side with no claim and runs its steps, comparing what every step returns (the outcome and incumbent of an evaluation, the frame of a claim or a refusal, the frame of an announcement) and the state after it (the incumbent and whether it is the side's own device);
   - each term is judged supersedable or not as the file says;
   - each pair of device-ids is ordered as the file says;
   - every list holds the number of entries the file's header says.

   Not compared, because they only name: every `name`, and the layout version (checked to be the one this test reads). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CoordinatorElection,
  compareDeviceIds,
  isSupersedableTerm,
} from "../src/domain/coordinator-election.js";
import {
  coordinatorFrameSchema,
  type CoordinatorFrame,
} from "../src/generated/protocol.js";
import { bytesFromHex } from "./hex.js";

const LAYOUT_VERSION = 1;
const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/);

const claimSchema = z.strictObject({
  term: z.number().int(),
  coordinator_hex: hexString,
  capacity_hint: z.number().int().nullable(),
});

const stepSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("evaluate"),
    frame: z.string(),
    expected: z.strictObject({
      outcome: z.enum(["accepted", "retained", "rejected"]),
      incumbent: claimSchema.nullable(),
    }),
    state: z.strictObject({
      current: claimSchema.nullable(),
      is_self: z.boolean(),
    }),
  }),
  z.strictObject({
    op: z.literal("claim"),
    capacity_hint: z.number().int().nullable(),
    expected: z.strictObject({
      frame: z.string().nullable(),
      refused: z.boolean(),
    }),
    state: z.strictObject({
      current: claimSchema.nullable(),
      is_self: z.boolean(),
    }),
  }),
  z.strictObject({
    op: z.literal("announce_current"),
    expected: z.strictObject({ frame: z.string().nullable() }),
    state: z.strictObject({
      current: claimSchema.nullable(),
      is_self: z.boolean(),
    }),
  }),
]);

const file = z
  .object({
    vectors: z.array(z.object({ name: z.string(), message: z.unknown() })),
    coordinator_election: z.strictObject({
      layout_version: z.literal(LAYOUT_VERSION),
      scenarios: z.array(
        z.strictObject({
          name: z.string(),
          own_device_hex: hexString,
          steps: z.array(stepSchema),
        }),
      ),
      supersedable_terms: z.array(
        z.strictObject({ term: z.number().int(), expected: z.boolean() }),
      ),
      device_orders: z.array(
        z.strictObject({
          name: z.string(),
          a_hex: hexString,
          b_hex: hexString,
          expected: z.number().int(),
        }),
      ),
      counts: z.strictObject({
        scenarios: z.number().int(),
        supersedable_terms: z.number().int(),
        device_orders: z.number().int(),
      }),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../conformance/coordinator-election.v1.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ),
  );
const section = file.coordinator_election;

/** The frame of a vector, rebuilt from its message: the file's JSON form carries a byte string as `{ "hex": ... }`. */
function frameOf(name: string): CoordinatorFrame {
  const found = file.vectors.find((vector) => vector.name === name);
  if (found === undefined) {
    throw new Error(`vector file has no vector ${name}`);
  }
  const message = z
    .strictObject({
      type: z.literal("coordinator"),
      term: z.number().int(),
      coordinator: z.strictObject({ hex: hexString }),
      "capacity-hint": z.number().int().optional(),
    })
    .parse(found.message);

  return coordinatorFrameSchema.parse({
    type: message.type,
    term: message.term,
    coordinator: bytesFromHex(message.coordinator.hex),
    ...(message["capacity-hint"] === undefined
      ? {}
      : { "capacity-hint": message["capacity-hint"] }),
  });
}

function claimOf(
  claim: z.infer<typeof claimSchema> | null,
):
  { term: number; coordinator: Uint8Array; capacityHint?: number } | undefined {
  return claim === null
    ? undefined
    : {
        term: claim.term,
        coordinator: bytesFromHex(claim.coordinator_hex),
        ...(claim.capacity_hint === null
          ? {}
          : { capacityHint: claim.capacity_hint }),
      };
}

describe("the file's own accounting", () => {
  it("holds the number of entries its header says", () => {
    expect(section.scenarios).toHaveLength(section.counts.scenarios);
    expect(section.supersedable_terms).toHaveLength(
      section.counts.supersedable_terms,
    );
    expect(section.device_orders).toHaveLength(section.counts.device_orders);
  });
});

describe("CoordinatorElection", () => {
  for (const scenario of section.scenarios) {
    it(scenario.name, () => {
      const election = new CoordinatorElection({
        ownDevice: bytesFromHex(scenario.own_device_hex),
      });
      expect(election.current()).toBeUndefined();

      for (const step of scenario.steps) {
        if (step.op === "evaluate") {
          const verdict = election.evaluate(frameOf(step.frame));
          expect(verdict.outcome).toBe(step.expected.outcome);
          expect(
            verdict.outcome === "rejected" ? undefined : verdict.incumbent,
          ).toEqual(claimOf(step.expected.incumbent));
        } else if (step.op === "claim") {
          const hint = step.capacity_hint ?? undefined;
          if (step.expected.refused) {
            expect(() => election.claim(hint)).toThrow(RangeError);
          } else {
            expect(election.claim(hint)).toEqual(
              frameOf(step.expected.frame ?? ""),
            );
          }
        } else {
          const announced = election.announceCurrent();
          expect(announced).toEqual(
            step.expected.frame === null
              ? undefined
              : frameOf(step.expected.frame),
          );
        }
        expect(election.current()).toEqual(claimOf(step.state.current));
        expect(election.isSelf()).toBe(step.state.is_self);
      }
    });
  }
});

describe("isSupersedableTerm", () => {
  for (const { term, expected } of section.supersedable_terms) {
    it(`judges term ${String(term)}`, () => {
      expect(isSupersedableTerm(term)).toBe(expected);
    });
  }
});

describe("compareDeviceIds", () => {
  for (const order of section.device_orders) {
    it(order.name, () => {
      expect(
        Math.sign(
          compareDeviceIds(
            bytesFromHex(order.a_hex),
            bytesFromHex(order.b_hex),
          ),
        ),
      ).toBe(order.expected);
    });
  }
});
