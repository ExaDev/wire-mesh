// The console's human reading of a session: what a person wants to know happened ("connected", "pairing established", "peer seen", "certificate changed"), derived from the session's state changes and the frames that crossed it. The raw frames stay available beside it for debugging. Pure, so the wording and the change detection can be tested without a session.

import type { SessionEvent } from "wire-mesh-core/domain/mesh-session";
import type { DeviceId, Frame } from "wire-mesh-core/generated/protocol";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";

export type ActivityKind =
  "connection" | "peer" | "pairing" | "relay" | "certificate";

export interface ActivityEntry {
  key: string;
  /** When the console observed it, from the injected clock. */
  at: number;
  kind: ActivityKind;
  /** The sentence, which ends where the peer's name goes when `peer` is set. */
  summary: string;
  /** Hex device-id of the peer the entry is about, named by the console's naming convention when shown. */
  peer: string | undefined;
}

/** What has already been turned into entries, so the next event yields only what is new. */
export interface ActivityTracker {
  /** How many frame-log entries have been read. The log only ever grows. */
  frames: number;
  /** The connection stage last reported: the status, with the attempt number while reconnecting, so each failed retry is a change and a repeated event is not. */
  stage: string | undefined;
  handshake: string | undefined;
  /** Sequence for entry keys. */
  issued: number;
  /** Hex device-ids already reported as seen. A directory is gossiped again and again with the same peers, so each is reported the first time only; otherwise a busy directory would push every other entry out of the capped activity view. */
  seen: ReadonlySet<string>;
}

export const initialTracker: ActivityTracker = {
  frames: 0,
  stage: undefined,
  handshake: undefined,
  issued: 0,
  seen: new Set(),
};

type Described = Pick<ActivityEntry, "kind" | "summary" | "peer">;

function hex(device: DeviceId): string {
  return deviceIdToHex(device);
}

/** What one frame means to a person, or nothing for plumbing (pings, handshakes and the like have their own views or are only for the raw log). */
export function describeFrame(
  direction: "sent" | "received",
  frame: Readonly<Frame>,
): Described[] {
  if (frame.type === "gossip") {
    return direction === "received"
      ? frame.peers.map((advert) => ({
          kind: "peer",
          summary: "Peer seen:",
          peer: hex(advert.device),
        }))
      : [
          {
            kind: "peer",
            summary: "Advertised this console to the node",
            peer: undefined,
          },
        ];
  }
  if (frame.type === "relay-connect") {
    return [
      {
        kind: "pairing",
        summary: "Asked the node to pair this console with",
        peer: hex(frame["target-device"]),
      },
    ];
  }
  if (frame.type === "relay-inbound") {
    return [
      {
        kind: "pairing",
        summary: "Pairing established with",
        peer: hex(frame["source-device"]),
      },
    ];
  }
  if (frame.type === "relay-data") {
    const other =
      direction === "sent" ? frame["to-device"] : frame["from-device"];
    return [
      {
        kind: "relay",
        summary:
          direction === "sent"
            ? "Relayed a message to"
            : "Relayed message received from",
        peer: other === undefined ? undefined : hex(other),
      },
    ];
  }
  if (frame.type === "close") {
    return [
      {
        kind: "connection",
        summary: "The node closed the connection",
        peer: undefined,
      },
    ];
  }
  return [];
}

function connectionStage(state: Readonly<SessionEvent["state"]>): string {
  return state.status === "reconnecting"
    ? `reconnecting:${String(state.attempt)}`
    : state.status;
}

function describeState(
  previous: Readonly<ActivityTracker>,
  state: Readonly<SessionEvent["state"]>,
  handshake: string | undefined,
): Described[] {
  const entries: Described[] = [];
  const connection = (summary: string): void => {
    entries.push({ kind: "connection", summary, peer: undefined });
  };
  if (connectionStage(state) !== previous.stage) {
    switch (state.status) {
      case "connecting":
        connection(`Connecting to ${state.address}`);
        break;
      case "connected":
        connection(`Connected to ${state.address}`);
        break;
      case "reconnecting":
        connection(
          `${previous.stage?.startsWith("reconnecting") === true ? "Retry failed" : "Connection lost"} (${state.reason}); retrying, attempt ${String(state.attempt)}`,
        );
        break;
      case "closed":
        connection(`Closed (${state.reason})`);
        break;
      case "idle":
        break;
    }
  }
  if (state.status === "connected" && handshake !== previous.handshake) {
    if (state.handshake.status === "negotiated") {
      connection(
        `Handshake negotiated: ${state.handshake.sharedDomains.join(", ")}`,
      );
    } else if (state.handshake.status === "unanswered") {
      connection("The node does not answer handshakes (a relay-only node)");
    } else if (state.handshake.status === "rejected") {
      connection(`Handshake rejected (${state.handshake.reason})`);
    }
  }
  return entries;
}

/** The handshake stage of a state, or undefined when not connected. */
function handshakeStage(
  state: Readonly<SessionEvent["state"]>,
): string | undefined {
  return state.status === "connected" ? state.handshake.status : undefined;
}

/** The entries an event adds beyond what `tracker` has already seen, and the tracker to use for the next event. */
export function advanceActivity(
  tracker: Readonly<ActivityTracker>,
  event: Readonly<SessionEvent>,
  at: number,
): { tracker: ActivityTracker; entries: ActivityEntry[] } {
  const handshake = handshakeStage(event.state);
  const seen = new Set(tracker.seen);
  const described: Described[] = [
    ...describeState(tracker, event.state, handshake),
    ...event.frameLog
      .slice(tracker.frames)
      .flatMap((entry) => describeFrame(entry.direction, entry.frame))
      .filter((entry) => {
        if (entry.kind !== "peer" || entry.peer === undefined) {
          return true;
        }
        if (seen.has(entry.peer)) {
          return false;
        }
        seen.add(entry.peer);
        return true;
      }),
  ];
  const entries = described.map((entry, index): ActivityEntry => ({
    ...entry,
    key: `activity-${String(tracker.issued + index)}`,
    at,
  }));
  return {
    tracker: {
      frames: event.frameLog.length,
      stage: connectionStage(event.state),
      handshake,
      issued: tracker.issued + entries.length,
      seen,
    },
    entries,
  };
}

/** The activity entries for certificate changes announced by a node, for merging into that node's connection activity. */
export function certificateActivity(
  changes: readonly { key: string; at: number; node: string }[],
): ActivityEntry[] {
  return changes.map((change) => ({
    key: `certificate-${change.key}`,
    at: change.at,
    kind: "certificate",
    summary: `Certificate changed: ${change.node} announced certificates unlike the remembered ones`,
    peer: undefined,
  }));
}
