import { describe, expect, it } from "vitest";
import type { SessionEvent } from "wire-mesh-core/domain/mesh-session";
import type { Frame } from "wire-mesh-core/generated/protocol";
import {
  advanceActivity,
  certificateActivity,
  describeFrame,
  initialTracker,
} from "../src/activity.js";
import { deviceIdFromFillHex } from "./hex.js";
import { syntheticAdvertProof } from "./synthetic-advert.js";

const ADDRESS = "wss://hub.example";
const DEVICE_ID_BYTES = 32;
const AT_THIRD = 3;
const AT_FOURTH = 4;
const PEER = deviceIdFromFillHex("22");
const PEER_HEX = "22".repeat(DEVICE_ID_BYTES);

function event(
  state: SessionEvent["state"],
  frameLog: SessionEvent["frameLog"] = [],
): SessionEvent {
  return { state, directory: [], frameLog };
}

describe("describeFrame", () => {
  it("names each peer seen in received gossip", () => {
    const frame: Frame = {
      type: "gossip",
      peers: [
        {
          device: PEER,
          addresses: [],
          "snapshot-seconds": 0,
          ...syntheticAdvertProof(),
        },
      ],
    };

    expect(describeFrame("received", frame)).toEqual([
      { kind: "peer", summary: "Peer seen:", peer: PEER_HEX },
    ]);
  });

  it("reads relay pairing and relayed data in either direction", () => {
    expect(
      describeFrame("received", {
        type: "relay-inbound",
        "source-device": PEER,
      }),
    ).toEqual([
      { kind: "pairing", summary: "Pairing established with", peer: PEER_HEX },
    ]);
    expect(
      describeFrame("sent", {
        type: "relay-data",
        payload: new Uint8Array(),
        "to-device": PEER,
      }),
    ).toEqual([
      { kind: "relay", summary: "Relayed a message to", peer: PEER_HEX },
    ]);
    expect(
      describeFrame("received", {
        type: "relay-data",
        payload: new Uint8Array(),
        "from-device": PEER,
      }),
    ).toEqual([
      {
        kind: "relay",
        summary: "Relayed message received from",
        peer: PEER_HEX,
      },
    ]);
  });

  it("says nothing about plumbing frames", () => {
    expect(describeFrame("sent", { type: "ping" })).toEqual([]);
    expect(describeFrame("received", { type: "pong" })).toEqual([]);
  });
});

describe("advanceActivity", () => {
  it("reports a connection and its negotiated handshake once each", () => {
    const connecting = advanceActivity(
      initialTracker,
      event({ status: "connecting", address: ADDRESS }),
      1,
    );
    const connected = advanceActivity(
      connecting.tracker,
      event({
        status: "connected",
        address: ADDRESS,
        handshake: { status: "pending" },
      }),
      2,
    );
    const negotiated = event({
      status: "connected",
      address: ADDRESS,
      handshake: {
        status: "negotiated",
        version: 1,
        sharedDomains: ["core/room"],
      },
    });
    const handshaken = advanceActivity(connected.tracker, negotiated, AT_THIRD);
    const repeated = advanceActivity(handshaken.tracker, negotiated, AT_FOURTH);

    expect(connecting.entries.map((entry) => entry.summary)).toEqual([
      `Connecting to ${ADDRESS}`,
    ]);
    expect(connected.entries.map((entry) => entry.summary)).toEqual([
      `Connected to ${ADDRESS}`,
    ]);
    expect(handshaken.entries.map((entry) => entry.summary)).toEqual([
      "Handshake negotiated: core/room",
    ]);
    expect(repeated.entries).toEqual([]);
  });

  it("reports only the frames added since the last event, with unique keys", () => {
    const state: SessionEvent["state"] = {
      status: "connected",
      address: ADDRESS,
      handshake: { status: "pending" },
    };
    const inbound: Frame = { type: "relay-inbound", "source-device": PEER };
    const first = advanceActivity(
      initialTracker,
      event(state, [{ direction: "received", frame: inbound }]),
      1,
    );
    const second = advanceActivity(
      first.tracker,
      event(state, [
        { direction: "received", frame: inbound },
        { direction: "received", frame: inbound },
      ]),
      2,
    );

    expect(first.entries.map((entry) => entry.kind)).toEqual([
      "connection",
      "pairing",
    ]);
    expect(second.entries.map((entry) => entry.kind)).toEqual(["pairing"]);
    const keys = [...first.entries, ...second.entries].map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("distinguishes the first loss of a connection from a failed retry", () => {
    const lost = advanceActivity(
      initialTracker,
      event({
        status: "reconnecting",
        address: ADDRESS,
        attempt: 1,
        reason: "network down",
      }),
      1,
    );
    const failed = advanceActivity(
      lost.tracker,
      event({
        status: "reconnecting",
        address: ADDRESS,
        attempt: 2,
        reason: "still down",
      }),
      2,
    );
    const duplicate = advanceActivity(
      failed.tracker,
      event({
        status: "reconnecting",
        address: ADDRESS,
        attempt: 2,
        reason: "still down",
      }),
      AT_THIRD,
    );

    expect(lost.entries.map((entry) => entry.summary)).toEqual([
      "Connection lost (network down); retrying, attempt 1",
    ]);
    expect(failed.entries.map((entry) => entry.summary)).toEqual([
      "Retry failed (still down); retrying, attempt 2",
    ]);
    expect(duplicate.entries).toEqual([]);
  });
});

describe("certificateActivity", () => {
  it("makes one certificate entry per change, at the time it was announced", () => {
    expect(
      certificateActivity([{ key: "c1", at: 5, node: "192.0.2.5:4433" }]),
    ).toEqual([
      {
        key: "certificate-c1",
        at: 5,
        kind: "certificate",
        summary:
          "Certificate changed: 192.0.2.5:4433 announced certificates unlike the remembered ones",
        peer: undefined,
      },
    ]);
  });
});
