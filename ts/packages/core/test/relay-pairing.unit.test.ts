import { describe, expect, it } from "vitest";
import { createRelayPairings } from "../src/domain/relay-pairing.js";
import { deviceIdFromFillHex } from "./hex.js";

describe("relay pairings", () => {
  const deviceA = deviceIdFromFillHex("11");
  const deviceB = deviceIdFromFillHex("22");

  it("lists nothing before any pairing is added", () => {
    const pairings = createRelayPairings();
    expect(pairings.list()).toEqual([]);
  });

  it("lists every added device, in establishment order", () => {
    const pairings = createRelayPairings();
    pairings.add(deviceA);
    pairings.add(deviceB);
    expect(pairings.list()).toEqual([deviceA, deviceB]);
  });

  it("does not list the same device twice when it is added again", () => {
    const pairings = createRelayPairings();
    pairings.add(deviceA);
    pairings.add(deviceA);
    expect(pairings.list()).toEqual([deviceA]);
  });

  it("forgets a removed device, so it is no longer listed or reported as paired", () => {
    const pairings = createRelayPairings();
    pairings.add(deviceA);
    pairings.add(deviceB);
    pairings.remove(deviceA);
    expect(pairings.has(deviceA)).toBe(false);
    expect(pairings.list()).toEqual([deviceB]);
  });

  it("treats removing a device that was never paired as a no-op", () => {
    const pairings = createRelayPairings();
    pairings.add(deviceA);
    pairings.remove(deviceB);
    expect(pairings.list()).toEqual([deviceA]);
  });
});
