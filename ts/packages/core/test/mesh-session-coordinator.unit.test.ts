import { describe, expect, it } from "vitest";
import type { CoordinatorFrame } from "../src/generated/protocol.js";
import { createMeshSession } from "../src/domain/mesh-session.js";
import { CoordinatorElection } from "../src/domain/coordinator-election.js";
import { deviceIdFromFillHex } from "./hex.js";
import {
  fakeTransport,
  testClock,
  testIdentity,
  yielded,
} from "./mesh-session-fixtures.js";

const OWN = deviceIdFromFillHex("aa");
const OTHER = deviceIdFromFillHex("11");

// Named epochs, so the wire assertions read as the election's own vocabulary rather than bare counts.
const TERM_FIRST_EVER = 0;
const TERM_REMOTE_HEARD = 5;
const CAPACITY_HINT_SENT = 3;

describe("coordinator-frame plumbing", () => {
  it("sends a claim minted by the election unchanged over the connection", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const election = new CoordinatorElection({ ownDevice: OWN });

    await session.sendCoordinatorClaim(election.claim(CAPACITY_HINT_SENT));

    expect(connection.sent.at(-1)).toEqual({
      type: "coordinator",
      term: TERM_FIRST_EVER,
      coordinator: OWN,
      "capacity-hint": CAPACITY_HINT_SENT,
    } satisfies CoordinatorFrame);
    await session.close();
  });

  it("surfaces an incoming coordinator-frame on coordinatorFrames, and an election fed from it supersedes correctly", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const election = new CoordinatorElection({ ownDevice: OWN });

    const received = (async (): Promise<CoordinatorFrame> => {
      const iterator = session.coordinatorFrames[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);

      return yielded(first);
    })();

    connection.push({
      type: "coordinator",
      term: TERM_REMOTE_HEARD,
      coordinator: OTHER,
    } satisfies CoordinatorFrame);

    const frame = await received;
    expect(frame.term).toBe(TERM_REMOTE_HEARD);
    const outcome = election.evaluate(frame);
    expect(outcome.outcome).toBe("accepted");
    expect(election.current()?.coordinator).toEqual(OTHER);
    await session.close();
  });
});
