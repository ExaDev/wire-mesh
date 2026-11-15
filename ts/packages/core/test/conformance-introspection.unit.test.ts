/* Checks every case of conformance/introspection.v1.json against the real path-trace and topology functions and the generated schemas. The schemas below are strict, so a key this test does not read fails it. In summary:

   - each typed frame is read through the schema of the shape the file names and every field and the keys of the open tail are compared with the file;
   - each frame that breaks a rule of a shape is refused by that shape's schema, and the valid frame it varies is accepted;
   - buildPathTraceResponse gives the outcome the file records;
   - tracePath and sendTopologyGet, run against a scripted peer and clock, give the result or the failure the file records;
   - readTopologyPeers and assembleTopologyGraph give the topology and the graph the file records;
   - every list holds the number of entries the file's header says.

   Not compared, because they only name: every `name`, and the layout version (checked to be the one this test reads). The generated schemas do not close a closed CDDL map (a key beyond the rule is stripped, not refused), so the cases that depend on that are flagged `rust_only` and only the Rust binary runs them. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import { bytesToHex } from "../src/domain/device-id.js";
import type { ManageOutcome } from "../src/domain/mesh-session.js";
import { buildPathTraceResponse, tracePath } from "../src/domain/path-trace.js";
import {
  assembleTopologyGraph,
  readTopologyPeers,
  sendTopologyGet,
} from "../src/domain/topology.js";
import {
  frameSchema,
  manageErrorSchema,
  manageOkSchema,
  pathTraceOkSchema,
  pathTraceSchema,
  topologyGetSchema,
  topologyPeersSchema,
  type PeerAdvert,
} from "../src/generated/protocol.js";
import { bytesFromHex } from "./hex.js";

const LAYOUT_VERSION = 1;
const DEVICE_BYTES = 32;
const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/);
const SHAPES = [
  "path.trace",
  "topology.get",
  "path-trace-ok",
  "topology-get-ok",
] as const;
const shapeName = z.enum(SHAPES);
type Shape = (typeof SHAPES)[number];

const peersFields = z.strictObject({
  direct_hex: z.array(hexString),
  relayed: z.array(
    z.strictObject({ device_hex: hexString, via_hex: hexString.nullable() }),
  ),
});
const reply = z.union([
  z.strictObject({ vector: z.string() }),
  z.strictObject({ closed: z.literal(true) }),
]);

const file = z
  .object({
    vectors: z.array(z.object({ name: z.string(), wire_hex: hexString })),
    introspection: z.strictObject({
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
      path_trace_responses: z.array(
        z.strictObject({
          name: z.string(),
          relayed: z.boolean(),
          hub_address: z.string().nullable(),
          vector: z.string(),
        }),
      ),
      trace_cases: z.array(
        z.strictObject({
          name: z.string(),
          relayed: z.boolean(),
          local_hub_address: z.string().nullable(),
          clock_ms: z.tuple([z.number().int(), z.number().int()]),
          reply,
          expected: z.union([
            z.strictObject({ error: z.enum(["malformed", "send"]) }),
            z.strictObject({
              rtt_ms: z.number().int(),
              local: z.strictObject({
                relayed: z.boolean(),
                hub_address: z.string().nullable(),
              }),
              remote: z
                .strictObject({
                  relayed: z.boolean(),
                  hub_address: z.string().nullable(),
                })
                .nullable(),
              outcome: z.enum(["ok", "error"]),
            }),
          ]),
        }),
      ),
      topology_reads: z.array(
        z.strictObject({
          name: z.string(),
          vector: z.string(),
          expected: peersFields.nullable(),
        }),
      ),
      topology_graphs: z.array(
        z.strictObject({
          name: z.string(),
          directory: z.array(
            z.strictObject({ device_hex: hexString, vector: z.string() }),
          ),
          expected: z.strictObject({
            nodes_hex: z.array(hexString),
            edges: z.array(
              z.strictObject({
                kind: z.enum(["direct", "relay"]),
                from_hex: hexString,
                to_hex: hexString,
                via_hex: hexString.nullable(),
              }),
            ),
          }),
        }),
      ),
      topology_get_cases: z.array(
        z.strictObject({
          name: z.string(),
          reply,
          expected: z.union([
            z.strictObject({ peers: peersFields }),
            z.strictObject({ error: z.literal("refused"), code: z.string() }),
            z.strictObject({ error: z.enum(["malformed", "send"]) }),
          ]),
        }),
      ),
      counts: z.strictObject({
        typed: z.number().int(),
        refused: z.number().int(),
        path_trace_responses: z.number().int(),
        trace_cases: z.number().int(),
        topology_reads: z.number().int(),
        topology_graphs: z.number().int(),
        topology_get_cases: z.number().int(),
      }),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../conformance/introspection.v1.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ),
  );
const section = file.introspection;

function wireOf(name: string): Uint8Array {
  const found = file.vectors.find((vector) => vector.name === name);
  if (found === undefined) {
    throw new Error(`vector file has no vector ${name}`);
  }

  return bytesFromHex(found.wire_hex);
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

const topologyGetOkSchema = z
  .object({ result: z.literal("ok"), peers: topologyPeersSchema })
  .catchall(z.unknown());

const SCHEMAS = {
  "path.trace": pathTraceSchema,
  "topology.get": topologyGetSchema,
  "path-trace-ok": pathTraceOkSchema,
  "topology-get-ok": topologyGetOkSchema,
} as const satisfies Record<Shape, z.ZodType>;

const KNOWN_KEYS: Readonly<Record<Shape, readonly string[]>> = {
  "path.trace": ["verb"],
  "topology.get": ["verb"],
  "path-trace-ok": ["result", "relayed", "hub-address"],
  "topology-get-ok": ["result", "peers"],
};

const hexOf = (bytes: Uint8Array): string => bytesToHex(bytes);

function peersProjection(peers: z.infer<typeof topologyPeersSchema>) {
  return {
    direct_hex: peers.direct.map(hexOf),
    relayed: peers.relayed.map((entry) => ({
      device_hex: hexOf(entry.device),
      via_hex: entry.via === undefined ? null : hexOf(entry.via),
    })),
  };
}

function project(shape: Shape, body: unknown): Record<string, unknown> {
  if (shape === "path.trace" || shape === "topology.get") {
    return {};
  }
  if (shape === "path-trace-ok") {
    const value = pathTraceOkSchema.parse(body);

    return {
      relayed: value.relayed,
      hub_address: value["hub-address"] ?? null,
    };
  }

  return { peers: peersProjection(topologyGetOkSchema.parse(body).peers) };
}

describe("the file's own accounting", () => {
  it("holds the number of entries its header says", () => {
    expect(section.typed).toHaveLength(section.counts.typed);
    expect(section.refused).toHaveLength(section.counts.refused);
    expect(section.path_trace_responses).toHaveLength(
      section.counts.path_trace_responses,
    );
    expect(section.trace_cases).toHaveLength(section.counts.trace_cases);
    expect(section.topology_reads).toHaveLength(section.counts.topology_reads);
    expect(section.topology_graphs).toHaveLength(
      section.counts.topology_graphs,
    );
    expect(section.topology_get_cases).toHaveLength(
      section.counts.topology_get_cases,
    );
  });

  it("has a typed vector for every shape, and a refusal's control is of its shape", () => {
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
      const body = bodyOf(wire);
      const parsed = SCHEMAS[entry.shape].parse(body);
      const { extra_keys: expectedKeys, ...expected } = entry.fields;
      expect(
        Object.keys(parsed as object)
          .filter((key) => !KNOWN_KEYS[entry.shape].includes(key))
          .sort(),
      ).toEqual(
        expectedKeys === undefined
          ? []
          : z.array(z.string()).parse(expectedKeys),
      );
      expect(project(entry.shape, body)).toEqual(expected);
    });
  }
});

describe("a frame that breaks a rule of its shape", () => {
  for (const entry of section.refused.filter((held) => !held.rust_only)) {
    it(`${entry.name} is refused as ${entry.shape}`, () => {
      expect(
        SCHEMAS[entry.shape].safeParse(
          bodyOf(bytesFromHex(entry.frame_wire_hex)),
        ).success,
      ).toBe(false);
      expect(
        SCHEMAS[entry.shape].safeParse(bodyOf(wireOf(entry.control))).success,
      ).toBe(true);
    });
  }
});

describe("buildPathTraceResponse", () => {
  for (const entry of section.path_trace_responses) {
    it(entry.name, () => {
      const outcome = buildPathTraceResponse(
        {
          requestId: 1,
          command: { verb: "path:trace", params: { verb: "path.trace" } },
          scope: { kind: "node" },
          ...(entry.relayed
            ? { fromDevice: bytesFromHex("01".repeat(DEVICE_BYTES)) }
            : {}),
          respond: async () => {
            await Promise.resolve();
          },
        },
        entry.hub_address ?? undefined,
      );
      expect(bytesToHex(encode(outcome, cdeEncodeOptions))).toBe(
        bytesToHex(encode(bodyOf(wireOf(entry.vector)), cdeEncodeOptions)),
      );
    });
  }
});

/** The outcome a scripted peer answers with, read back from its response frame. */
function outcomeOf(name: string): ManageOutcome {
  return z
    .union([manageOkSchema, manageErrorSchema])
    .parse(bodyOf(wireOf(name)));
}

function scriptedSession(replyOf: z.infer<typeof reply>) {
  return {
    sendManageRequest: async (): Promise<ManageOutcome> =>
      "closed" in replyOf
        ? Promise.reject(new Error("connection closed"))
        : Promise.resolve(outcomeOf(replyOf.vector)),
  };
}

describe("tracePath", () => {
  for (const entry of section.trace_cases) {
    it(entry.name, async () => {
      const ticks = [...entry.clock_ms];
      const clock = { now: (): number => ticks.shift() ?? 0 };
      const run = tracePath({
        session: scriptedSession(entry.reply),
        clock,
        ...(entry.relayed
          ? { targetDevice: bytesFromHex("02".repeat(DEVICE_BYTES)) }
          : {}),
        ...(entry.local_hub_address === null
          ? {}
          : { localHubAddress: entry.local_hub_address }),
      });
      if ("error" in entry.expected) {
        await expect(run).rejects.toThrow();

        return;
      }
      const result = await run;
      expect(result.rttMs).toBe(entry.expected.rtt_ms);
      expect({
        relayed: result.local.relayed,
        hub_address: result.local.hubAddress ?? null,
      }).toEqual(entry.expected.local);
      expect(
        result.remote === undefined
          ? null
          : {
              relayed: result.remote.relayed,
              hub_address: result.remote.hubAddress ?? null,
            },
      ).toEqual(entry.expected.remote);
      expect(result.outcome.result).toBe(entry.expected.outcome);
    });
  }
});

describe("sendTopologyGet", () => {
  for (const entry of section.topology_get_cases) {
    it(entry.name, async () => {
      const run = sendTopologyGet(scriptedSession(entry.reply));
      if ("peers" in entry.expected) {
        expect(peersProjection(await run)).toEqual(entry.expected.peers);

        return;
      }
      await expect(run).rejects.toThrow(
        entry.expected.error === "refused"
          ? `refused (${entry.expected.code})`
          : entry.expected.error === "malformed"
            ? "malformed"
            : "connection closed",
      );
    });
  }
});

/** The peer-advert inside a gossip frame vector. */
function advertOf(name: string): PeerAdvert {
  const frame = frameSchema.parse(decode(wireOf(name), cdeDecodeOptions));
  if (frame.type !== "gossip" || frame.peers[0] === undefined) {
    throw new Error(`${name} is not a gossip frame holding an advert`);
  }

  return frame.peers[0];
}

describe("readTopologyPeers", () => {
  for (const entry of section.topology_reads) {
    it(entry.name, () => {
      const read = readTopologyPeers(advertOf(entry.vector));
      expect(read === undefined ? null : peersProjection(read)).toEqual(
        entry.expected,
      );
    });
  }
});

describe("assembleTopologyGraph", () => {
  for (const entry of section.topology_graphs) {
    it(entry.name, () => {
      const graph = assembleTopologyGraph(
        entry.directory.map((member) => ({
          device: bytesFromHex(member.device_hex),
          advert: advertOf(member.vector),
        })),
      );
      expect({
        nodes_hex: graph.nodes.map(hexOf),
        edges: graph.edges.map((edge) => ({
          kind: edge.kind,
          from_hex: hexOf(edge.from),
          to_hex: hexOf(edge.to),
          via_hex:
            edge.kind === "relay" && edge.via !== undefined
              ? hexOf(edge.via)
              : null,
        })),
      }).toEqual(entry.expected);
    });
  }
});
