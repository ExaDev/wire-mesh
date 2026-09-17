import { describe, expect, it } from "vitest";
import {
  decodeShards,
  encodeShards,
  type PresentedShard,
} from "../src/domain/erasure-coding.js";

// Named K/N pairs: a config change is a one-line diff, and each pair documents the shape it exercises.
const K2_N2 = { dataShards: 2, totalShards: 2 };
const K2_N3 = { dataShards: 2, totalShards: 3 };
const K2_N4 = { dataShards: 2, totalShards: 4 };
const K2_N5 = { dataShards: 2, totalShards: 5 };
const K3_N4 = { dataShards: 3, totalShards: 4 };
const K3_N5 = { dataShards: 3, totalShards: 5 };
const ZERO: number[] = [0];
const ZERO_BYTE = 0;

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** "mesh" + one zero pad byte, the padded second half of the pinned vector input. */
function meshPadded(): Uint8Array {
  return Uint8Array.from([...text("mesh"), ZERO_BYTE]);
}

/** The cross-language pin: K=2 N=3 over "wire-mesh" -- the Rust suite carries the identical assertion. */
// Each byte named: the pin is the payload, and this keeps every literal explained.
const PARITY_PIN_BYTE_0 = 101;
const PARITY_PIN_BYTE_1 = 153;
const PARITY_PIN_BYTE_2 = 227;
const PARITY_PIN_BYTE_3 = 111;
const PARITY_PIN_BYTE_4 = 152;
const PARITY_PIN: number[] = [
  PARITY_PIN_BYTE_0,
  PARITY_PIN_BYTE_1,
  PARITY_PIN_BYTE_2,
  PARITY_PIN_BYTE_3,
  PARITY_PIN_BYTE_4,
];
const SHARD_INDEX_SEVEN = 7;
const INDEX_RANGE_0_2 = /outside 0\.\.2/;

/** The survivors of dropping the given original indices, keeping explicit shard indices -- the shape a manifest-driven reader naturally produces. */
function survivorsOf(
  shards: readonly Uint8Array[],
  ...dropped: readonly number[]
): PresentedShard[] {
  return shards
    .map((data, index): PresentedShard | undefined =>
      dropped.includes(index) ? undefined : { index, data },
    )
    .filter((entry): entry is PresentedShard => entry !== undefined);
}

describe("encodeShards / decodeShards", () => {
  it("reconstructs the original bytes from exactly K of N shards, for every K-subset", async () => {
    const data = text("erasure-coded notice content");
    const shards = await encodeShards(data, K3_N5);
    expect(shards).toHaveLength(K3_N5.totalShards);

    // Every K-subset must reconstruct: the erasure guarantee itself.
    for (let drop1 = 0; drop1 < K3_N5.totalShards; drop1 += 1) {
      for (let drop2 = drop1 + 1; drop2 < K3_N5.totalShards; drop2 += 1) {
        const decoded = await decodeShards(
          survivorsOf(shards, drop1, drop2),
          K3_N5,
          data.length,
        );
        expect(decoded).toEqual(data);
      }
    }
  });

  it("round-trips a K=N configuration (pure splitting, no parity)", async () => {
    const data = text("split me");
    const shards = await encodeShards(data, K2_N2);
    expect(shards[0]).toEqual(text("spli"));
    expect(shards[1]).toEqual(text("t me"));
    const decoded = await decodeShards(survivorsOf(shards), K2_N2, data.length);
    expect(decoded).toEqual(data);
  });

  it("reconstructs from the FIRST K shards (all data shards present)", async () => {
    const data = text("data shards alone");
    const shards = await encodeShards(data, K3_N4);
    const decoded = await decodeShards(
      survivorsOf(shards, K3_N4.dataShards),
      K3_N4,
      data.length,
    );
    expect(decoded).toEqual(data);
  });

  it("reconstructs with ZERO data shards present (parity only)", async () => {
    // N-K must be at least K for a parity-only survivor set to exist.
    const data = text("parity only");
    const shards = await encodeShards(data, K2_N5);
    const decoded = await decodeShards(
      survivorsOf(shards, 0, 1),
      K2_N5,
      data.length,
    );
    expect(decoded).toEqual(data);
  });

  it("pads the last shard: input not a multiple of K still reconstructs to the exact original length", async () => {
    const data = text("abcde"); // not a multiple of K3_N5.dataShards
    const shards = await encodeShards(data, K3_N5);
    const decoded = await decodeShards(
      survivorsOf(shards, 1, 2),
      K3_N5,
      data.length,
    );
    expect(decoded).toEqual(data);
    expect(decoded).toHaveLength(data.length); // not the padded length
  });

  it("rejects fewer than K shards outright", async () => {
    const data = text("too few");
    const shards = await encodeShards(data, K3_N5);
    await expect(
      decodeShards(
        survivorsOf(
          shards,
          K2_N2.totalShards,
          K2_N3.totalShards,
          K2_N4.totalShards,
        ),
        K3_N5,
        data.length,
      ),
    ).rejects.toThrow(
      new RegExp(`at least ${String(K3_N5.dataShards)} shards`, "i"),
    );
  });

  it("rejects an impossible configuration (total < data, or shards beyond the field)", async () => {
    const data = text("x");
    await expect(
      encodeShards(data, {
        dataShards: K3_N5.dataShards,
        totalShards: K2_N2.totalShards,
      }),
    ).rejects.toThrow(/at least.*data/i);
    const BEYOND_FIELD = 256; // GF(2^8) holds 255 shard rows; 256 deliberately exceeds it
    await expect(
      encodeShards(data, {
        dataShards: BEYOND_FIELD,
        totalShards: BEYOND_FIELD + 1,
      }),
    ).rejects.toThrow(/field/i);
  });

  it("rejects a shard index outside the configured range", async () => {
    const data = text("bounds");
    const shards = await encodeShards(data, K2_N3);
    await expect(
      decodeShards(
        [
          { index: 0, data: shards[0] ?? Uint8Array.from(ZERO) },
          {
            index: SHARD_INDEX_SEVEN,
            data: shards[1] ?? Uint8Array.from(ZERO),
          },
        ],
        K2_N3,
        data.length,
      ),
    ).rejects.toThrow(INDEX_RANGE_0_2);
  });

  it("empty input round-trips", async () => {
    const shards = await encodeShards(new Uint8Array(0), K2_N3);
    const decoded = await decodeShards(survivorsOf(shards, 1), K2_N3, 0);
    expect(decoded).toHaveLength(0);
  });

  it("handles binary input including zero bytes", async () => {
    const MAX_BYTE = 255;
    const MID_BYTE = 128;
    const TAIL_BYTE = 7;
    const ONE = 1;
    const BINARY_INPUT: number[] = [
      ZERO_BYTE,
      MAX_BYTE,
      ZERO_BYTE,
      ONE,
      ZERO_BYTE,
      MID_BYTE,
      ZERO_BYTE,
      ZERO_BYTE,
      TAIL_BYTE,
    ];
    const data = Uint8Array.from(BINARY_INPUT);
    const shards = await encodeShards(data, K2_N4);
    const SHARD_0 = 0;
    const SHARD_1 = 1;
    const SHARD_2 = 2;
    const SHARD_3 = 3;
    const DROP_SETS: number[][] = [
      [SHARD_0],
      [SHARD_1],
      [SHARD_2],
      [SHARD_3],
      [SHARD_0, SHARD_1],
      [SHARD_0, SHARD_2],
      [SHARD_1, SHARD_3],
      [SHARD_2, SHARD_3],
    ];
    for (const dropped of DROP_SETS) {
      const decoded = await decodeShards(
        survivorsOf(shards, ...dropped),
        K2_N4,
        data.length,
      );
      expect(decoded).toEqual(data);
    }
  });

  it("produces the byte-pinned cross-language vector: K=2 N=3 over 'wire-mesh' (the Rust port must match exactly)", async () => {
    const data = text("wire-mesh"); // 9 bytes: halves are "wire-" and "mesh" + one pad zero
    const shards = await encodeShards(data, K2_N3);
    expect(shards[0]).toEqual(text("wire-"));
    expect(shards[1]).toEqual(meshPadded());
    // The parity shard is Cauchy row 2 over the halves: inv(2^0)*L ^ inv(2^1)*R per byte, byte-identical to the Rust suite's own pin.
    const parity = shards[2];
    if (parity === undefined) throw new Error("parity shard missing");
    expect([...parity]).toEqual(PARITY_PIN);
    const roundTrip = await decodeShards(
      [
        { index: 0, data: shards[0] ?? Uint8Array.from(ZERO) },
        { index: K2_N3.totalShards - 1, data: parity },
      ],
      K2_N3,
      data.length,
    );
    expect(roundTrip).toEqual(data);
  });
});
