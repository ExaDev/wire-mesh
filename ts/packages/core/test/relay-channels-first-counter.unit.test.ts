// The first send counter of every channel is validated when the relay channels are constructed, not when the first hello arrives.

import { describe, expect, it } from "vitest";
import { createRelayChannels } from "../src/domain/relay-channels.js";
import { ManualClock } from "./relay-channels-harness.js";
import { generateEd25519Identity } from "./tokens-fixtures.js";

const FRACTIONAL_COUNTER = 1.5;

describe("the first send counter of every channel", () => {
  it("is validated when the relay channels are constructed", async () => {
    const a = await generateEd25519Identity();

    for (const bad of [Number.NaN, -1, FRACTIONAL_COUNTER]) {
      expect(() =>
        createRelayChannels(
          a,
          async () => Promise.resolve(),
          new ManualClock(),
          {
            firstSendCounter: bad,
          },
        ),
      ).toThrow(RangeError);
    }
  });
});
