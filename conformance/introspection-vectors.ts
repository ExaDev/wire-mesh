/* introspection.v1.json: core/management's path:trace and topology.get (spec/management.cddl), the topology-peers value they and a peer-advert's `topology/peers` gossip extension carry, and what the helpers built on them return.

   The top-level vectors are the frames the cases use (manage-request and manage-response frames, and gossip frames each holding one peer-advert), round-tripped like any other file. The `introspection` section holds what a round trip cannot: for each frame the shape it must decode to and every field of it; frames that each break one rule of a shape; the answer built for a path.trace; traces run against a scripted peer and clock; the topology read from an advert's extension; the graph assembled from a directory; and topology.get run against a scripted peer. Every outcome is written by hand from the spec, never produced by an implementation. Device-ids, keys and signatures are structural bytes, as in the other vector files: an advert here is not verified. */

import { hex, type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";
import { wireHex } from "./secure-channel-crypto.ts";

export const INTROSPECTION_LAYOUT_VERSION = 1;

const DEVICE_BYTES = 32;
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const EDDSA = -8;
const SNAPSHOT_SECONDS = 1_861_920_000;
const HUB = "203.0.113.9:4433";
const OTHER_HUB = "198.51.100.2:7000";
const START_MS = 1_000;
const RTT_MS = 42;
const TIMEOUT_CODE = "timeout";

const A = "01".repeat(DEVICE_BYTES);
const B = "02".repeat(DEVICE_BYTES);
const C = "03".repeat(DEVICE_BYTES);
const D = "04".repeat(DEVICE_BYTES);

interface Peers {
  direct: string[];
  relayed: { device: string; via?: string }[];
}

function peersJson(peers: Peers): JsonWire {
  return {
    direct: peers.direct.map((device) => hex(device)),
    relayed: peers.relayed.map((entry) => ({
      device: hex(entry.device),
      ...(entry.via === undefined ? {} : { via: hex(entry.via) }),
    })),
  };
}

function peersFields(peers: Peers): JsonWire {
  return {
    direct_hex: peers.direct,
    relayed: peers.relayed.map((entry) => ({
      device_hex: entry.device,
      via_hex: entry.via ?? null,
    })),
  };
}

const NO_PEERS: Peers = { direct: [], relayed: [] };
const SOME_PEERS: Peers = {
  direct: [A],
  relayed: [{ device: B, via: A }, { device: C }],
};

type Shape =
  "path.trace" | "topology.get" | "path-trace-ok" | "topology-get-ok";

interface Typed {
  name: string;
  shape: Shape;
  body: JsonWire;
  fields: JsonWire;
}

const TYPED: readonly Typed[] = [
  {
    name: "path_trace_request",
    shape: "path.trace",
    body: { verb: "path.trace" },
    fields: {},
  },
  {
    name: "topology_get_request",
    shape: "topology.get",
    body: { verb: "topology.get" },
    fields: {},
  },
  {
    name: "path_trace_ok_direct",
    shape: "path-trace-ok",
    body: { result: "ok", relayed: false },
    fields: { relayed: false, hub_address: null, extra_keys: [] },
  },
  {
    name: "path_trace_ok_relayed_with_a_hub",
    shape: "path-trace-ok",
    body: { result: "ok", relayed: true, "hub-address": HUB },
    fields: { relayed: true, hub_address: HUB, extra_keys: [] },
  },
  {
    name: "path_trace_ok_relayed_without_a_hub_address",
    shape: "path-trace-ok",
    body: { result: "ok", relayed: true },
    fields: { relayed: true, hub_address: null, extra_keys: [] },
  },
  {
    name: "path_trace_ok_with_extensions",
    shape: "path-trace-ok",
    body: { result: "ok", relayed: false, ab: 1, "load-hint": "low" },
    fields: {
      relayed: false,
      hub_address: null,
      extra_keys: ["ab", "load-hint"],
    },
  },
  {
    name: "topology_get_ok_empty",
    shape: "topology-get-ok",
    body: { result: "ok", peers: peersJson(NO_PEERS) },
    fields: { peers: peersFields(NO_PEERS), extra_keys: [] },
  },
  {
    name: "topology_get_ok_direct_and_relayed",
    shape: "topology-get-ok",
    body: { result: "ok", peers: peersJson(SOME_PEERS) },
    fields: { peers: peersFields(SOME_PEERS), extra_keys: [] },
  },
  {
    name: "topology_get_ok_with_an_extension",
    shape: "topology-get-ok",
    body: {
      result: "ok",
      peers: peersJson(SOME_PEERS),
      as_of: SNAPSHOT_SECONDS,
    },
    fields: { peers: peersFields(SOME_PEERS), extra_keys: ["as_of"] },
  },
];

interface Refused {
  name: string;
  control: string;
  shape: Shape;
  body: JsonWire;
  /** The Rust decoder refuses the frame and the TypeScript schema accepts it (it strips a key a closed map does not name), so only the Rust binary runs it. */
  rustOnly?: boolean;
}

const REFUSED: readonly Refused[] = [
  {
    name: "path_trace_ok_without_relayed",
    control: "path_trace_ok_direct",
    shape: "path-trace-ok",
    body: { result: "ok" },
  },
  {
    name: "path_trace_ok_with_relayed_as_text",
    control: "path_trace_ok_direct",
    shape: "path-trace-ok",
    body: { result: "ok", relayed: "no" },
  },
  {
    name: "path_trace_ok_with_a_hub_address_that_is_not_text",
    control: "path_trace_ok_relayed_with_a_hub",
    shape: "path-trace-ok",
    body: { result: "ok", relayed: true, "hub-address": 7 },
  },
  {
    name: "topology_get_ok_without_peers",
    control: "topology_get_ok_direct_and_relayed",
    shape: "topology-get-ok",
    body: { result: "ok" },
  },
  {
    name: "topology_get_ok_with_peers_that_is_not_a_map",
    control: "topology_get_ok_direct_and_relayed",
    shape: "topology-get-ok",
    body: { result: "ok", peers: [hex(A)] },
  },
  {
    name: "topology_get_ok_without_direct",
    control: "topology_get_ok_direct_and_relayed",
    shape: "topology-get-ok",
    body: { result: "ok", peers: { relayed: [] } },
  },
  {
    name: "topology_get_ok_without_relayed",
    control: "topology_get_ok_direct_and_relayed",
    shape: "topology-get-ok",
    body: { result: "ok", peers: { direct: [] } },
  },
  {
    name: "topology_get_ok_with_a_direct_device_of_the_wrong_length",
    control: "topology_get_ok_direct_and_relayed",
    shape: "topology-get-ok",
    body: {
      result: "ok",
      peers: { direct: [hex("01".repeat(DEVICE_BYTES - 1))], relayed: [] },
    },
  },
  {
    name: "topology_get_ok_with_a_relayed_entry_without_a_device",
    control: "topology_get_ok_direct_and_relayed",
    shape: "topology-get-ok",
    body: { result: "ok", peers: { direct: [], relayed: [{ via: hex(A) }] } },
  },
  {
    name: "path_trace_with_a_key_the_rule_does_not_name",
    control: "path_trace_request",
    shape: "path.trace",
    body: { verb: "path.trace", hint: 1 },
    rustOnly: true,
  },
  {
    name: "topology_get_with_a_key_the_rule_does_not_name",
    control: "topology_get_request",
    shape: "topology.get",
    body: { verb: "topology.get", hint: 1 },
    rustOnly: true,
  },
  {
    name: "topology_get_ok_with_peers_that_carry_a_key_the_rule_does_not_name",
    control: "topology_get_ok_direct_and_relayed",
    shape: "topology-get-ok",
    body: { result: "ok", peers: { direct: [], relayed: [], hint: 1 } },
    rustOnly: true,
  },
  {
    name: "topology_get_ok_with_a_relayed_entry_that_carries_a_key_the_rule_does_not_name",
    control: "topology_get_ok_direct_and_relayed",
    shape: "topology-get-ok",
    body: {
      result: "ok",
      peers: { direct: [], relayed: [{ device: hex(A), hint: 1 }] },
    },
    rustOnly: true,
  },
];

/** The frame carrying a body: a request for the verbs, a response for the outcomes. */
function frameOf(shape: Shape, body: JsonWire, id: number): JsonWire {
  if (shape === "path.trace" || shape === "topology.get") {
    return {
      type: "manage-request",
      "request-id": id,
      command: {
        verb: shape === "path.trace" ? "path:trace" : "topology:get",
        params: body,
      },
      scope: { kind: "node" },
    };
  }

  return { type: "manage-response", "request-id": id, outcome: body };
}

function advertOf(device: string, peers: Peers | "malformed" | null): JsonWire {
  return {
    device: hex(device),
    addresses: [],
    "snapshot-seconds": SNAPSHOT_SECONDS,
    "identity-key": { alg: EDDSA, "public-key": hex("00".repeat(KEY_BYTES)) },
    signature: hex("00".repeat(SIGNATURE_BYTES)),
    ...(peers === null
      ? {}
      : {
          "topology/peers":
            peers === "malformed" ? "not a topology" : peersJson(peers),
        }),
  };
}

interface Graph {
  name: string;
  /** The devices of the directory, each with what its advert reports. */
  directory: readonly { device: string; peers: Peers | "malformed" | null }[];
  nodes: readonly string[];
  edges: readonly {
    kind: "direct" | "relay";
    from: string;
    to: string;
    via?: string;
  }[];
}

const GRAPHS: readonly Graph[] = [
  {
    name: "an_empty_directory",
    directory: [],
    nodes: [],
    edges: [],
  },
  {
    name: "a_device_that_reports_nothing_is_a_node_with_no_edges",
    directory: [{ device: A, peers: null }],
    nodes: [A],
    edges: [],
  },
  {
    name: "direct_and_relayed_edges_attributed_to_the_reporter",
    directory: [
      { device: A, peers: { direct: [B], relayed: [{ device: C, via: B }] } },
      { device: B, peers: null },
    ],
    nodes: [A, B],
    edges: [
      { kind: "direct", from: A, to: B },
      { kind: "relay", from: A, to: C, via: B },
    ],
  },
  {
    name: "a_relay_edge_without_a_known_hub",
    directory: [{ device: A, peers: { direct: [], relayed: [{ device: D }] } }],
    nodes: [A],
    edges: [{ kind: "relay", from: A, to: D }],
  },
  {
    name: "two_devices_reporting_one_connection_give_two_edges",
    directory: [
      { device: A, peers: { direct: [B], relayed: [] } },
      { device: B, peers: { direct: [A], relayed: [] } },
    ],
    nodes: [A, B],
    edges: [
      { kind: "direct", from: A, to: B },
      { kind: "direct", from: B, to: A },
    ],
  },
  {
    name: "a_malformed_report_is_no_report",
    directory: [
      { device: A, peers: "malformed" },
      { device: B, peers: { direct: [A], relayed: [] } },
    ],
    nodes: [A, B],
    edges: [{ kind: "direct", from: B, to: A }],
  },
  {
    name: "edges_follow_the_order_of_the_directory_then_direct_before_relayed",
    directory: [
      {
        device: C,
        peers: { direct: [D, A], relayed: [{ device: B, via: D }] },
      },
      { device: A, peers: { direct: [C], relayed: [] } },
    ],
    nodes: [C, A],
    edges: [
      { kind: "direct", from: C, to: D },
      { kind: "direct", from: C, to: A },
      { kind: "relay", from: C, to: B, via: D },
      { kind: "direct", from: A, to: C },
    ],
  },
];

const READS: readonly {
  name: string;
  device: string;
  peers: Peers | "malformed" | null;
  expected: Peers | null;
}[] = [
  {
    name: "an_advert_with_no_extension",
    device: A,
    peers: null,
    expected: null,
  },
  {
    name: "an_advert_with_an_empty_report",
    device: A,
    peers: NO_PEERS,
    expected: NO_PEERS,
  },
  {
    name: "an_advert_with_direct_and_relayed_peers",
    device: C,
    peers: SOME_PEERS,
    expected: SOME_PEERS,
  },
  {
    name: "an_advert_whose_extension_is_not_a_topology",
    device: A,
    peers: "malformed",
    expected: null,
  },
];

const TRACES: readonly {
  name: string;
  relayed: boolean;
  local_hub_address: string | null;
  clock_ms: readonly [number, number];
  reply: { body: JsonWire; shape: Shape } | "closed";
  expected: JsonWire;
}[] = [
  {
    name: "a_relayed_path_reports_both_sides",
    relayed: true,
    local_hub_address: HUB,
    clock_ms: [START_MS, START_MS + RTT_MS],
    reply: {
      shape: "path-trace-ok",
      body: { result: "ok", relayed: true, "hub-address": OTHER_HUB },
    },
    expected: {
      rtt_ms: RTT_MS,
      local: { relayed: true, hub_address: HUB },
      remote: { relayed: true, hub_address: OTHER_HUB },
      outcome: "ok",
    },
  },
  {
    name: "a_direct_path_reports_no_local_hub_address_even_when_one_is_known",
    relayed: false,
    local_hub_address: HUB,
    clock_ms: [START_MS, START_MS + RTT_MS],
    reply: { shape: "path-trace-ok", body: { result: "ok", relayed: false } },
    expected: {
      rtt_ms: RTT_MS,
      local: { relayed: false, hub_address: null },
      remote: { relayed: false, hub_address: null },
      outcome: "ok",
    },
  },
  {
    name: "a_relayed_path_with_no_known_hub_address",
    relayed: true,
    local_hub_address: null,
    clock_ms: [START_MS, START_MS],
    reply: { shape: "path-trace-ok", body: { result: "ok", relayed: true } },
    expected: {
      rtt_ms: 0,
      local: { relayed: true, hub_address: null },
      remote: { relayed: true, hub_address: null },
      outcome: "ok",
    },
  },
  {
    name: "a_clock_that_went_backwards_reads_as_no_time",
    relayed: false,
    local_hub_address: null,
    clock_ms: [START_MS, START_MS - RTT_MS],
    reply: { shape: "path-trace-ok", body: { result: "ok", relayed: false } },
    expected: {
      rtt_ms: 0,
      local: { relayed: false, hub_address: null },
      remote: { relayed: false, hub_address: null },
      outcome: "ok",
    },
  },
  {
    name: "an_error_outcome_has_no_remote",
    relayed: false,
    local_hub_address: null,
    clock_ms: [START_MS, START_MS + RTT_MS],
    reply: {
      shape: "path-trace-ok",
      body: { result: "error", code: TIMEOUT_CODE },
    },
    expected: {
      rtt_ms: RTT_MS,
      local: { relayed: false, hub_address: null },
      remote: null,
      outcome: "error",
    },
  },
  {
    name: "an_ok_that_is_not_a_path_trace_ok_is_a_protocol_violation",
    relayed: false,
    local_hub_address: null,
    clock_ms: [START_MS, START_MS + RTT_MS],
    reply: { shape: "path-trace-ok", body: { result: "ok", relayed: "yes" } },
    expected: { error: "malformed" },
  },
  {
    name: "a_connection_that_ends_is_a_send_error",
    relayed: false,
    local_hub_address: null,
    clock_ms: [START_MS, START_MS],
    reply: "closed",
    expected: { error: "send" },
  },
];

const RESPONSES: readonly {
  name: string;
  relayed: boolean;
  hub_address: string | null;
  body: JsonWire;
}[] = [
  {
    name: "relayed_with_a_hub_address",
    relayed: true,
    hub_address: HUB,
    body: { result: "ok", relayed: true, "hub-address": HUB },
  },
  {
    name: "relayed_with_no_address_to_report",
    relayed: true,
    hub_address: null,
    body: { result: "ok", relayed: true },
  },
  {
    name: "direct_leaves_out_an_address_the_caller_has",
    relayed: false,
    hub_address: HUB,
    body: { result: "ok", relayed: false },
  },
  {
    name: "direct_with_no_address",
    relayed: false,
    hub_address: null,
    body: { result: "ok", relayed: false },
  },
];

const GETS: readonly {
  name: string;
  reply: { body: JsonWire; shape: Shape } | "closed";
  expected: JsonWire;
}[] = [
  {
    name: "a_live_answer",
    reply: {
      shape: "topology-get-ok",
      body: { result: "ok", peers: peersJson(SOME_PEERS) },
    },
    expected: { peers: peersFields(SOME_PEERS) },
  },
  {
    name: "an_empty_answer",
    reply: {
      shape: "topology-get-ok",
      body: { result: "ok", peers: peersJson(NO_PEERS) },
    },
    expected: { peers: peersFields(NO_PEERS) },
  },
  {
    name: "an_error_is_a_refusal_with_its_code",
    reply: {
      shape: "topology-get-ok",
      body: { result: "error", code: "denied" },
    },
    expected: { error: "refused", code: "denied" },
  },
  {
    name: "an_ok_without_peers_is_malformed",
    reply: { shape: "topology-get-ok", body: { result: "ok" } },
    expected: { error: "malformed" },
  },
  {
    name: "an_ok_with_peers_that_are_not_topology_peers_is_malformed",
    reply: {
      shape: "topology-get-ok",
      body: { result: "ok", peers: { direct: "nobody", relayed: [] } },
    },
    expected: { error: "malformed" },
  },
  {
    name: "a_connection_that_ends_is_a_send_error",
    reply: "closed",
    expected: { error: "send" },
  },
];

export function introspectionFile(): {
  vectors: Vector[];
  extra: Record<string, JsonWire>;
} {
  const vectors: Vector[] = [];
  const named = new Set<string>();
  let id = 0;

  function add(name: string, message: JsonWire): string {
    if (!named.has(name)) {
      named.add(name);
      vectors.push({ name, message, wire_hex: wireHex(message) });
    }

    return name;
  }

  function replyJson(
    reply: { body: JsonWire; shape: Shape } | "closed",
    label: string,
  ): JsonWire {
    if (reply === "closed") {
      return { closed: true };
    }
    id += 1;

    return {
      vector: add(`reply_${label}`, {
        type: "manage-response",
        "request-id": id,
        outcome: reply.body,
      }),
    };
  }

  const typed = TYPED.map((entry): JsonWire => {
    id += 1;

    return {
      vector: add(entry.name, frameOf(entry.shape, entry.body, id)),
      shape: entry.shape,
      fields: entry.fields,
    };
  });
  const refused = REFUSED.map((entry): JsonWire => {
    const control = TYPED.find((candidate) => candidate.name === entry.control);
    if (control?.shape !== entry.shape) {
      throw new Error(`${entry.name} and its control are not the same shape`);
    }

    return {
      name: entry.name,
      shape: entry.shape,
      control: entry.control,
      rust_only: entry.rustOnly ?? false,
      frame_wire_hex: wireHex(frameOf(entry.shape, entry.body, 1)),
    };
  });
  const responses = RESPONSES.map((entry): JsonWire => ({
    name: entry.name,
    relayed: entry.relayed,
    hub_address: entry.hub_address,
    vector: add(`response_${entry.name}`, {
      type: "manage-response",
      "request-id": 1,
      outcome: entry.body,
    }),
  }));
  const traces = TRACES.map((entry): JsonWire => ({
    name: entry.name,
    relayed: entry.relayed,
    local_hub_address: entry.local_hub_address,
    clock_ms: [...entry.clock_ms],
    reply: replyJson(entry.reply, `trace_${entry.name}`),
    expected: entry.expected,
  }));
  const advertFrame = (
    label: string,
    device: string,
    peers: Peers | "malformed" | null,
  ): string =>
    add(`advert_${label}`, {
      type: "gossip",
      peers: [advertOf(device, peers)],
    });
  const reads = READS.map((entry): JsonWire => ({
    name: entry.name,
    vector: advertFrame(`read_${entry.name}`, entry.device, entry.peers),
    expected: entry.expected === null ? null : peersFields(entry.expected),
  }));
  const graphs = GRAPHS.map((entry): JsonWire => ({
    name: entry.name,
    directory: entry.directory.map((member, index) => ({
      device_hex: member.device,
      vector: advertFrame(
        `graph_${entry.name}_${String(index)}`,
        member.device,
        member.peers,
      ),
    })),
    expected: {
      nodes_hex: [...entry.nodes],
      edges: entry.edges.map((edge) => ({
        kind: edge.kind,
        from_hex: edge.from,
        to_hex: edge.to,
        via_hex: edge.via ?? null,
      })),
    },
  }));
  const gets = GETS.map((entry): JsonWire => ({
    name: entry.name,
    reply: replyJson(entry.reply, `get_${entry.name}`),
    expected: entry.expected,
  }));

  return {
    vectors,
    extra: {
      introspection: {
        layout_version: INTROSPECTION_LAYOUT_VERSION,
        typed,
        refused,
        path_trace_responses: responses,
        trace_cases: traces,
        topology_reads: reads,
        topology_graphs: graphs,
        topology_get_cases: gets,
        counts: {
          typed: typed.length,
          refused: refused.length,
          path_trace_responses: responses.length,
          trace_cases: traces.length,
          topology_reads: reads.length,
          topology_graphs: graphs.length,
          topology_get_cases: gets.length,
        },
      },
    },
  };
}
