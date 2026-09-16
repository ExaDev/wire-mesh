import { describe, expect, it } from "vitest";
import { cdeDecodeOptions, decode, encode, cdeEncodeOptions } from "cbor2";
import {
  decodeShardManifest,
  encodeShardManifest,
  splitForShardedDelivery,
  reconstructFromShards,
  SHARD_MANIFEST_CONTENT_TYPE,
  type ShardManifest,
} from "../src/domain/shard-manifest.js";
import {
  decryptNoticeContent,
  encryptNoticeContent,
  generateContentKey,
} from "../src/domain/group-key.js";
import type { PresentedShard } from "../src/domain/erasure-coding.js";

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const K2_N3 = { dataShards: 2, totalShards: 3 };
const MAX_BYTE = 255;
const BYTE_MODULUS = 256;
const SEVEN = 7;
const THREE = 3;
const LENGTH_42 = 42;
const FIRST_ID = 1;
const SECOND_ID = 2;
const THIRD_ID = 3;

/** Deterministic distinct device bytes: pattern-driven so no magic literals. */
function deviceBytes(pattern: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    { length: 32 },
    (_, i) => (i * pattern) % BYTE_MODULUS,
  );
}
const DEVICE_A = deviceBytes(1);
const DEVICE_B: Uint8Array<ArrayBuffer> = Uint8Array.from(
  { length: 32 },
  (_, i) => MAX_BYTE - (i % BYTE_MODULUS),
);
const DEVICE_C = deviceBytes(SEVEN);

function manifestFixture(): ShardManifest {
  return {
    "total-shards": THREE,
    threshold: K2_N3.dataShards,
    "content-type": "text/plain+aes256gcm",
    "original-length": LENGTH_42,
    shards: [
      {
        device: DEVICE_A,
        "transfer-id": Uint8Array.from([FIRST_ID]),
      },
      {
        device: DEVICE_B,
        "transfer-id": Uint8Array.from([SECOND_ID]),
      },
      {
        device: DEVICE_C,
        "transfer-id": Uint8Array.from([THIRD_ID]),
      },
    ],
  };
}

describe("shard manifest entry codec", () => {
  it("round-trips through the canonical core/data entry bytes", () => {
    const manifest = manifestFixture();
    const entry = encodeShardManifest(manifest);
    const decoded = decodeShardManifest(entry);
    expect(decoded).toEqual(manifest);
  });

  it("encodes as canonical CDE CBOR (a decode/re-encode is byte-identical)", () => {
    const entry = encodeShardManifest(manifestFixture());
    const reEncoded = new Uint8Array(
      encode(decode(entry, cdeDecodeOptions), cdeEncodeOptions),
    );
    expect(reEncoded).toEqual(entry);
  });

  it("rejects a manifest whose shards array does not match total-shards", () => {
    const manifest = manifestFixture();
    const mismatched = { ...manifest, "total-shards": THREE + 1 };
    expect(() => encodeShardManifest(mismatched)).toThrow(/shards but lists/);
  });

  it("rejects a manifest whose threshold exceeds total-shards", () => {
    const manifest = manifestFixture();
    const impossible = { ...manifest, threshold: THREE + 1 };
    expect(() => encodeShardManifest(impossible)).toThrow(/threshold/);
  });

  it("rejects malformed entry bytes loudly", () => {
    const INVALID_CBOR_BYTE = 0xff; // not a valid CBOR major-type/length prefix
    expect(() =>
      decodeShardManifest(Uint8Array.from([INVALID_CBOR_BYTE])),
    ).toThrow();
  });
});

describe("splitForShardedDelivery / reconstructFromShards", () => {
  it("encrypt-then-shard then fetch-any-K reconstruct-decrypt round trip, end to end", async () => {
    const contentKey = generateContentKey();
    const plaintext = text("sharded and secret across mailboxes");
    const ciphertext = await encryptNoticeContent(contentKey, plaintext);

    const targets = [DEVICE_A, DEVICE_B, DEVICE_C];
    const delivery = await splitForShardedDelivery(ciphertext, {
      config: K2_N3,
      contentType: "text/plain+aes256gcm",
      targets,
      nextTransferId: (index) => Uint8Array.from([index + 1]),
    });

    expect(delivery.shards).toHaveLength(THREE);
    expect(delivery.manifest["total-shards"]).toBe(THREE);
    expect(delivery.manifest.threshold).toBe(2);
    expect(delivery.manifest["original-length"]).toBe(ciphertext.length);
    expect(delivery.manifest.shards[0]?.device).toEqual(DEVICE_A);
    expect(delivery.manifest.shards[2]?.device).toEqual(DEVICE_C);
    // The manifest itself is a valid core/data entry.
    expect(() =>
      decodeShardManifest(encodeShardManifest(delivery.manifest)),
    ).not.toThrow();

    // A reader holding any K shards (here: shards 0 and 2, device B's lost) plus the manifest and the epoch key reconstructs the plaintext.
    const fetched: PresentedShard[] = [
      { index: 0, data: delivery.shards[0] ?? new Uint8Array(0) },
      { index: 2, data: delivery.shards[2] ?? new Uint8Array(0) },
    ];
    const restored = await reconstructFromShards(fetched, delivery.manifest, {
      decrypt: async (bytes) => decryptNoticeContent(contentKey, bytes),
    });
    expect(restored).toEqual(plaintext);
  });

  it("passes ciphertext through untouched when no decryptor is given (shard-only layer)", async () => {
    const payload = text("opaque payload");
    const delivery = await splitForShardedDelivery(payload, {
      config: K2_N3,
      contentType: "application/octet-stream",
      targets: [DEVICE_A, DEVICE_B, DEVICE_C],
      nextTransferId: (index) => Uint8Array.from([index + 1]),
    });
    const fetched: PresentedShard[] = delivery.shards.map((data, index) => ({
      index,
      data,
    }));
    const restored = await reconstructFromShards(fetched, delivery.manifest);
    expect(restored).toEqual(payload);
  });

  it("fails closed when fewer than threshold shards are presented", async () => {
    const payload = text("not enough");
    const delivery = await splitForShardedDelivery(payload, {
      config: K2_N3,
      contentType: "application/octet-stream",
      targets: [DEVICE_A, DEVICE_B, DEVICE_C],
      nextTransferId: (index) => Uint8Array.from([index + 1]),
    });
    await expect(
      reconstructFromShards(
        [{ index: 1, data: delivery.shards[1] ?? new Uint8Array(0) }],
        delivery.manifest,
      ),
    ).rejects.toThrow(/at least 2/);
  });

  it("rejects targets fewer than total-shards (every shard needs a home)", async () => {
    await expect(
      splitForShardedDelivery(text("x"), {
        config: K2_N3,
        contentType: "application/octet-stream",
        targets: [DEVICE_A, DEVICE_B],
        nextTransferId: (index) => Uint8Array.from([index + 1]),
      }),
    ).rejects.toThrow(/targets/);
  });
});

describe("SHARD_MANIFEST_CONTENT_TYPE", () => {
  it("names the manifest as a core/data application entry content type", () => {
    expect(SHARD_MANIFEST_CONTENT_TYPE).toBe(
      "application/x-wire-mesh-shard-manifest",
    );
  });
});
