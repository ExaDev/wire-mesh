/* data-sync.v1.json: what the core/data sync primitive (spec/data-domain.cddl) does to a store and returns, step by step.

   The frames round-trip like any other vector. The `data_sync` section holds scenarios: each starts from a store (a map of key to value, both hex) and runs steps, every step recording the frame or entries it returns and the whole store after it. The outcomes are written by hand from the spec, never produced by an implementation: an append writes the entry, then the head, a data-entries frame is applied only when its from-seq equals the store's head, a request returns at most the limit and stops at the first missing entry, and a data-have returns a request only when the announced head is above the store's. The layout (`data/<device-id-hex>/head` as decimal text and `data/<device-id-hex>/entry/<seq>`) is part of the contract: a store written by one implementation is read by the other. Device-ids are structural bytes, not hashes of keys. */

import { hex, type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";
import { wireHex } from "./secure-channel-crypto.ts";

export const DATA_SYNC_LAYOUT_VERSION = 1;

const DEVICE_ID_BYTES = 32;
const OWN = "01";
const PEER = "02";
const OTHER = "03";

type Device = typeof OWN | typeof PEER | typeof OTHER;

function deviceHex(device: Device): string {
  return device.repeat(DEVICE_ID_BYTES);
}

function textHex(text: string): string {
  return Buffer.from(text, "utf8").toString("hex");
}

function headKey(device: Device): string {
  return `data/${deviceHex(device)}/head`;
}

function entryKey(device: Device, seq: number): string {
  return `data/${deviceHex(device)}/entry/${String(seq)}`;
}

/** A store as the file records it: every key with its value in hex, in key order. */
type Store = Record<string, string>;

/** A log held in a store: its head and the entries from sequence 1, each entry a short text. */
function log(device: Device, entries: readonly string[], head?: number): Store {
  const store: Store = {
    [headKey(device)]: textHex(String(head ?? entries.length)),
  };
  entries.forEach((entry, index) => {
    store[entryKey(device, index + 1)] = textHex(entry);
  });

  return store;
}

function sorted(store: Readonly<Store>): Store {
  return Object.fromEntries(
    Object.entries(store).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function merge(...stores: readonly Store[]): Store {
  return sorted(stores.reduce<Store>((all, one) => ({ ...all, ...one }), {}));
}

type Frame =
  | { type: "have"; peer: Device; head: number }
  | { type: "request"; peer: Device; from: number }
  | { type: "entries"; peer: Device; from: number; entries: readonly string[] };

type Step =
  | { op: "head_seq_for"; peer: Device; returns: number }
  | { op: "append_own_entry"; entry: string; returns: number }
  | { op: "handle_data_have"; frame: Frame; returns: Frame | null }
  | {
      op: "handle_data_request";
      frame: Frame;
      limit: number;
      returns: Frame | null;
    }
  | { op: "handle_data_entries"; frame: Frame; returns: "applied" | "gap" }
  | {
      op: "read_entries";
      peer: Device;
      after: number;
      returns: readonly string[];
    };

/** What a step leaves in the store, given by the whole store so a stray write cannot hide. */
type StepWithStore = Step & { store: Store };

interface Scenario {
  name: string;
  own: Device;
  store: Store;
  steps: readonly StepWithStore[];
}

const have = (frame: Readonly<{ peer: Device; head: number }>): Frame => ({
  type: "have",
  ...frame,
});
const request = (frame: Readonly<{ peer: Device; from: number }>): Frame => ({
  type: "request",
  ...frame,
});
const entries = (frame: {
  peer: Device;
  from: number;
  items: readonly string[];
}): Frame => ({
  type: "entries",
  peer: frame.peer,
  from: frame.from,
  entries: frame.items,
});

const EMPTY: Store = {};
const own3 = log(OWN, ["a", "b", "c"]);
const peer2 = log(PEER, ["x", "y"]);
/** A log whose head claims three entries but whose second is missing. */
const HOLED: Store = Object.fromEntries(
  Object.entries(own3).filter(([key]) => key !== entryKey(OWN, 2)),
);

const scenarios: readonly Scenario[] = [
  {
    name: "an_empty_store_holds_nothing",
    own: OWN,
    store: EMPTY,
    steps: [
      { op: "head_seq_for", peer: OWN, returns: 0, store: EMPTY },
      { op: "head_seq_for", peer: PEER, returns: 0, store: EMPTY },
      { op: "read_entries", peer: PEER, after: 0, returns: [], store: EMPTY },
    ],
  },
  {
    name: "appends_are_monotonic_and_announced",
    own: OWN,
    store: EMPTY,
    steps: [
      {
        op: "append_own_entry",
        entry: "a",
        returns: 1,
        store: log(OWN, ["a"]),
      },
      {
        op: "append_own_entry",
        entry: "b",
        returns: 2,
        store: log(OWN, ["a", "b"]),
      },
      { op: "append_own_entry", entry: "c", returns: 3, store: own3 },
      { op: "head_seq_for", peer: OWN, returns: 3, store: own3 },
      {
        op: "read_entries",
        peer: OWN,
        after: 0,
        returns: ["a", "b", "c"],
        store: own3,
      },
      { op: "read_entries", peer: OWN, after: 2, returns: ["c"], store: own3 },
      { op: "read_entries", peer: OWN, after: 3, returns: [], store: own3 },
    ],
  },
  {
    name: "an_append_continues_a_log_the_store_already_holds",
    own: OWN,
    store: log(OWN, ["a", "b"]),
    steps: [{ op: "append_own_entry", entry: "c", returns: 3, store: own3 }],
  },
  {
    name: "logs_of_different_devices_are_independent",
    own: OWN,
    store: merge(own3, peer2),
    steps: [
      { op: "head_seq_for", peer: OWN, returns: 3, store: merge(own3, peer2) },
      { op: "head_seq_for", peer: PEER, returns: 2, store: merge(own3, peer2) },
      {
        op: "head_seq_for",
        peer: OTHER,
        returns: 0,
        store: merge(own3, peer2),
      },
      {
        op: "read_entries",
        peer: PEER,
        after: 0,
        returns: ["x", "y"],
        store: merge(own3, peer2),
      },
      {
        op: "append_own_entry",
        entry: "d",
        returns: 4,
        store: merge(log(OWN, ["a", "b", "c", "d"]), peer2),
      },
    ],
  },
  {
    name: "a_have_above_the_head_asks_for_what_follows_it",
    own: OWN,
    store: peer2,
    steps: [
      {
        op: "handle_data_have",
        frame: have({ peer: PEER, head: 5 }),
        returns: request({ peer: PEER, from: 2 }),
        store: peer2,
      },
      {
        op: "handle_data_have",
        frame: have({ peer: PEER, head: 3 }),
        returns: request({ peer: PEER, from: 2 }),
        store: peer2,
      },
      {
        op: "handle_data_have",
        frame: have({ peer: OTHER, head: 1 }),
        returns: request({ peer: OTHER, from: 0 }),
        store: peer2,
      },
    ],
  },
  {
    name: "a_have_at_or_below_the_head_asks_for_nothing",
    own: OWN,
    store: peer2,
    steps: [
      {
        op: "handle_data_have",
        frame: have({ peer: PEER, head: 2 }),
        returns: null,
        store: peer2,
      },
      {
        op: "handle_data_have",
        frame: have({ peer: PEER, head: 1 }),
        returns: null,
        store: peer2,
      },
      {
        op: "handle_data_have",
        frame: have({ peer: PEER, head: 0 }),
        returns: null,
        store: peer2,
      },
    ],
  },
  {
    name: "a_request_returns_the_entries_after_from_seq",
    own: OWN,
    store: own3,
    steps: [
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 0 }),
        limit: 10,
        returns: entries({ peer: OWN, from: 0, items: ["a", "b", "c"] }),
        store: own3,
      },
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 1 }),
        limit: 10,
        returns: entries({ peer: OWN, from: 1, items: ["b", "c"] }),
        store: own3,
      },
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 2 }),
        limit: 10,
        returns: entries({ peer: OWN, from: 2, items: ["c"] }),
        store: own3,
      },
    ],
  },
  {
    name: "a_request_at_or_past_the_head_or_for_an_unheld_log_returns_nothing",
    own: OWN,
    store: own3,
    steps: [
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 3 }),
        limit: 10,
        returns: null,
        store: own3,
      },
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 7 }),
        limit: 10,
        returns: null,
        store: own3,
      },
      {
        op: "handle_data_request",
        frame: request({ peer: PEER, from: 0 }),
        limit: 10,
        returns: null,
        store: own3,
      },
    ],
  },
  {
    name: "a_request_returns_at_most_the_limit",
    own: OWN,
    store: own3,
    steps: [
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 0 }),
        limit: 1,
        returns: entries({ peer: OWN, from: 0, items: ["a"] }),
        store: own3,
      },
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 0 }),
        limit: 2,
        returns: entries({ peer: OWN, from: 0, items: ["a", "b"] }),
        store: own3,
      },
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 1 }),
        limit: 1,
        returns: entries({ peer: OWN, from: 1, items: ["b"] }),
        store: own3,
      },
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 0 }),
        limit: 3,
        returns: entries({ peer: OWN, from: 0, items: ["a", "b", "c"] }),
        store: own3,
      },
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 0 }),
        limit: 0,
        returns: null,
        store: own3,
      },
    ],
  },
  {
    name: "a_replica_answers_for_the_author",
    own: OWN,
    store: merge(own3, peer2),
    steps: [
      {
        op: "handle_data_request",
        frame: request({ peer: PEER, from: 0 }),
        limit: 10,
        returns: entries({ peer: PEER, from: 0, items: ["x", "y"] }),
        store: merge(own3, peer2),
      },
    ],
  },
  {
    name: "a_run_is_cut_at_the_first_missing_entry",
    own: OWN,
    store: HOLED,
    steps: [
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 0 }),
        limit: 10,
        returns: entries({ peer: OWN, from: 0, items: ["a"] }),
        store: HOLED,
      },
      {
        op: "handle_data_request",
        frame: request({ peer: OWN, from: 1 }),
        limit: 10,
        returns: null,
        store: HOLED,
      },
      {
        op: "read_entries",
        peer: OWN,
        after: 0,
        returns: ["a"],
        store: HOLED,
      },
    ],
  },
  {
    name: "entries_that_start_at_the_head_are_applied",
    own: OWN,
    store: EMPTY,
    steps: [
      {
        op: "handle_data_entries",
        frame: entries({ peer: PEER, from: 0, items: ["x", "y"] }),
        returns: "applied",
        store: peer2,
      },
      {
        op: "handle_data_entries",
        frame: entries({ peer: PEER, from: 2, items: ["z"] }),
        returns: "applied",
        store: log(PEER, ["x", "y", "z"]),
      },
      {
        op: "read_entries",
        peer: PEER,
        after: 1,
        returns: ["y", "z"],
        store: log(PEER, ["x", "y", "z"]),
      },
    ],
  },
  {
    name: "entries_ahead_of_the_head_are_a_gap_and_write_nothing",
    own: OWN,
    store: peer2,
    steps: [
      {
        op: "handle_data_entries",
        frame: entries({ peer: PEER, from: 3, items: ["w"] }),
        returns: "gap",
        store: peer2,
      },
      {
        op: "handle_data_entries",
        frame: entries({ peer: PEER, from: 5, items: ["v", "u"] }),
        returns: "gap",
        store: peer2,
      },
      {
        op: "handle_data_entries",
        frame: entries({ peer: OTHER, from: 1, items: ["q"] }),
        returns: "gap",
        store: peer2,
      },
    ],
  },
  {
    name: "entries_behind_the_head_are_stale_and_write_nothing",
    own: OWN,
    store: peer2,
    steps: [
      {
        op: "handle_data_entries",
        frame: entries({ peer: PEER, from: 0, items: ["x", "y"] }),
        returns: "gap",
        store: peer2,
      },
      {
        op: "handle_data_entries",
        frame: entries({ peer: PEER, from: 1, items: ["y", "z"] }),
        returns: "gap",
        store: peer2,
      },
    ],
  },
  {
    name: "an_empty_entries_frame_at_the_head_applies_and_leaves_the_log_as_it_was",
    own: OWN,
    store: peer2,
    steps: [
      {
        op: "handle_data_entries",
        frame: entries({ peer: PEER, from: 2, items: [] }),
        returns: "applied",
        store: peer2,
      },
    ],
  },
  {
    name: "a_have_request_entries_round_trip_catches_a_replica_up",
    own: OWN,
    store: EMPTY,
    steps: [
      {
        op: "handle_data_have",
        frame: have({ peer: PEER, head: 2 }),
        returns: request({ peer: PEER, from: 0 }),
        store: EMPTY,
      },
      {
        op: "handle_data_entries",
        frame: entries({ peer: PEER, from: 0, items: ["x", "y"] }),
        returns: "applied",
        store: peer2,
      },
      {
        op: "handle_data_have",
        frame: have({ peer: PEER, head: 2 }),
        returns: null,
        store: peer2,
      },
    ],
  },
];

function frameName(frame: Frame): string {
  if (frame.type === "have") {
    return `data_have_${frame.peer}_h${String(frame.head)}`;
  }
  if (frame.type === "request") {
    return `data_request_${frame.peer}_f${String(frame.from)}`;
  }

  return `data_entries_${frame.peer}_f${String(frame.from)}_n${String(frame.entries.length)}_${frame.entries.join("")}`;
}

function frameMessage(frame: Frame): JsonWire {
  if (frame.type === "have") {
    return {
      type: "data-have",
      peer: hex(deviceHex(frame.peer)),
      "head-seq": frame.head,
    };
  }
  if (frame.type === "request") {
    return {
      type: "data-request",
      peer: hex(deviceHex(frame.peer)),
      "from-seq": frame.from,
    };
  }

  return {
    type: "data-entries",
    peer: hex(deviceHex(frame.peer)),
    "from-seq": frame.from,
    entries: frame.entries.map((entry) => hex(textHex(entry))),
  };
}

export function dataSyncFile(): {
  vectors: Vector[];
  extra: Record<string, JsonWire>;
} {
  const vectors: Vector[] = [];
  const named = new Set<string>();

  function register(frame: Frame): string {
    const name = frameName(frame);
    if (!named.has(name)) {
      named.add(name);
      const message = frameMessage(frame);
      vectors.push({ name, message, wire_hex: wireHex(message) });
    }

    return name;
  }

  function stepJson(step: StepWithStore, own: Device): JsonWire {
    const store = sorted(step.store);
    if (step.op === "head_seq_for") {
      return {
        op: step.op,
        peer_hex: deviceHex(step.peer),
        returns: step.returns,
        store,
      };
    }
    if (step.op === "append_own_entry") {
      return {
        op: step.op,
        entry_hex: textHex(step.entry),
        returns: step.returns,
        have_frame: register(have({ peer: own, head: step.returns })),
        store,
      };
    }
    if (step.op === "handle_data_have") {
      return {
        op: step.op,
        frame: register(step.frame),
        returns: step.returns === null ? null : register(step.returns),
        store,
      };
    }
    if (step.op === "handle_data_request") {
      return {
        op: step.op,
        frame: register(step.frame),
        limit: step.limit,
        returns: step.returns === null ? null : register(step.returns),
        store,
      };
    }
    if (step.op === "handle_data_entries") {
      return {
        op: step.op,
        frame: register(step.frame),
        returns: step.returns,
        store,
      };
    }

    return {
      op: step.op,
      peer_hex: deviceHex(step.peer),
      after: step.after,
      returns: step.returns.map(textHex),
      store,
    };
  }

  const scenarioJson = scenarios.map((scenario): JsonWire => ({
    name: scenario.name,
    own_device_hex: deviceHex(scenario.own),
    store: sorted(scenario.store),
    steps: scenario.steps.map((step) => stepJson(step, scenario.own)),
  }));

  return {
    vectors,
    extra: {
      data_sync: {
        layout_version: DATA_SYNC_LAYOUT_VERSION,
        scenarios: scenarioJson,
        counts: { scenarios: scenarios.length },
      },
    },
  };
}
