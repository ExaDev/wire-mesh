import { describe, expect, it } from "vitest";
import {
  CoordinatorElection,
  compareDeviceIds,
} from "../src/domain/coordinator-election.js";
import type { CoordinatorFrame, DeviceId } from "../src/generated/protocol.js";
import { deviceIdFromFillHex } from "./hex.js";

const OWN = deviceIdFromFillHex("aa");
const LOWER = deviceIdFromFillHex("11");
const HIGHER = deviceIdFromFillHex("ff");

// Arbitrary but distinct election epochs, so every comparison below is between named terms rather than bare counts.
const TERM_FIRST_EVER = 0;
const TERM_LOW = 3;
const TERM_MIDDLE = 4;
const TERM_HIGH = 5;
const TERM_HIGHEST = 6;
const CAPACITY_HINT = 7;
const LATE_CAPACITY_HINT = 9;
/** A fractional offset, to make a term that is not an integer. */
const HALF = 0.5;

/** A coordinator-frame naming `device` at `term`, the shape every evaluate test feeds. */
function claim(device: DeviceId, term: number): CoordinatorFrame {
  return { type: "coordinator", term, coordinator: device };
}

describe("CoordinatorElection.claim", () => {
  it("mints the first-ever term naming this device from fresh state", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    expect(election.claim()).toEqual({
      type: "coordinator",
      term: TERM_FIRST_EVER,
      coordinator: OWN,
    });
    expect(election.isSelf()).toBe(true);
  });

  it("raises the term above every term seen so far", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    election.evaluate(claim(HIGHER, TERM_HIGH));
    // claim() mints lastTerm + 1: one epoch above the highest term heard, the derivation the monotonic-term rule itself states.
    expect(election.claim().term).toBe(TERM_HIGH + 1);
    expect(election.isSelf()).toBe(true);
  });

  it("carries a capacity hint onto the wire frame", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    expect(election.claim(CAPACITY_HINT)["capacity-hint"]).toBe(CAPACITY_HINT);
  });
});

describe("CoordinatorElection.evaluate", () => {
  it("accepts the first claim it hears", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    const outcome = election.evaluate(claim(LOWER, TERM_LOW));
    expect(outcome).toEqual({
      outcome: "accepted",
      incumbent: { term: TERM_LOW, coordinator: LOWER },
    });
  });

  it("supersedes the incumbent on a strictly higher term", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    election.evaluate(claim(HIGHER, TERM_LOW));
    expect(election.evaluate(claim(LOWER, TERM_MIDDLE)).outcome).toBe(
      "accepted",
    );
    expect(election.current()?.coordinator).toEqual(LOWER);
  });

  it("retains the incumbent against a lower term, however high the incumbent's device-id", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    election.evaluate(claim(HIGHER, TERM_HIGH));
    expect(election.evaluate(claim(LOWER, TERM_MIDDLE)).outcome).toBe(
      "retained",
    );
    expect(incumbentDevice(election)).toEqual(HIGHER);
  });

  it("breaks equal terms by lowest device-id in both directions", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    election.evaluate(claim(HIGHER, TERM_LOW));
    expect(election.evaluate(claim(LOWER, TERM_LOW)).outcome).toBe("accepted");
    expect(election.evaluate(claim(HIGHER, TERM_LOW)).outcome).toBe("retained");
    expect(election.current()?.coordinator).toEqual(LOWER);
  });

  it("retains an identical refresh of the incumbent without treating it as a change", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    election.evaluate(claim(LOWER, TERM_LOW));
    expect(election.evaluate(claim(LOWER, TERM_LOW)).outcome).toBe("retained");
  });

  it("carries an incoming capacity hint onto the incumbent", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    const outcome = election.evaluate({
      ...claim(LOWER, TERM_MIDDLE),
      "capacity-hint": LATE_CAPACITY_HINT,
    });
    expect(election.current()?.capacityHint).toBe(LATE_CAPACITY_HINT);
    expect(outcome.outcome).toBe("accepted");
  });
});

describe("CoordinatorElection term ceiling", () => {
  // The highest term evaluate accepts: its successor, term + 1, is still an exactly represented integer, so it is strictly greater.
  const LAST_RAISABLE_TERM = Number.MAX_SAFE_INTEGER - 1;
  const UNRAISABLE_TERMS = [
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    -1,
    TERM_LOW + HALF,
  ];

  it.each(UNRAISABLE_TERMS)(
    "rejects a claim at term %s without making it the incumbent",
    (term) => {
      const election = new CoordinatorElection({ ownDevice: OWN });
      expect(election.evaluate(claim(LOWER, term))).toEqual({
        outcome: "rejected",
      });
      expect(election.current()).toBeUndefined();
    },
  );

  it("keeps the incumbent when an unraisable claim arrives", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    election.evaluate(claim(HIGHER, TERM_LOW));
    expect(
      election.evaluate(claim(LOWER, Number.MAX_SAFE_INTEGER)).outcome,
    ).toBe("rejected");
    expect(election.current()).toEqual({
      term: TERM_LOW,
      coordinator: HIGHER,
    });
    expect(election.claim().term).toBe(TERM_LOW + 1);
  });

  it("accepts a claim at the highest usable term, after which claim() refuses rather than mint a term peers would reject", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    expect(election.evaluate(claim(HIGHER, LAST_RAISABLE_TERM)).outcome).toBe(
      "accepted",
    );
    expect(() => election.claim()).toThrow(RangeError);
    expect(election.current()?.coordinator).toEqual(HIGHER);
  });

  it("mints a claim at the highest usable term that a peer accepts", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    election.evaluate(claim(HIGHER, LAST_RAISABLE_TERM - 1));
    const frame = election.claim();
    expect(frame.term).toBe(LAST_RAISABLE_TERM);
    const peer = new CoordinatorElection({ ownDevice: HIGHER });
    expect(peer.evaluate(frame).outcome).toBe("accepted");
  });
});

describe("CoordinatorElection.announceCurrent", () => {
  it("is undefined before any claim has been made or heard", () => {
    expect(
      new CoordinatorElection({ ownDevice: OWN }).announceCurrent(),
    ).toBeUndefined();
  });

  it("re-announces the incumbent at its own term rather than raising it", () => {
    const election = new CoordinatorElection({ ownDevice: OWN });
    election.evaluate(claim(LOWER, TERM_HIGHEST));
    expect(election.announceCurrent()).toEqual({
      type: "coordinator",
      term: TERM_HIGHEST,
      coordinator: LOWER,
    });
  });
});

describe("compareDeviceIds", () => {
  it("orders bytewise with the lower first byte lower", () => {
    expect(compareDeviceIds(LOWER, HIGHER)).toBeLessThan(0);
    expect(compareDeviceIds(HIGHER, LOWER)).toBeGreaterThan(0);
  });

  it("compares equal ids equal", () => {
    expect(compareDeviceIds(OWN, deviceIdFromFillHex("aa"))).toBe(0);
  });

  it("treats a prefix as lower than its extension", () => {
    const prefix = deviceIdFromFillHex("aa");
    const extension = new Uint8Array([...prefix, 0x00]);
    expect(compareDeviceIds(prefix, extension)).toBeLessThan(0);
  });
});

/** The incumbent's device, narrowed from current() for assertions that do not care about the term. */
function incumbentDevice(election: CoordinatorElection): DeviceId | undefined {
  return election.current()?.coordinator;
}
