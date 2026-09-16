/**
 * The shard manifest for wire-mesh#36's mailbox-opacity delivery (the composition half of #34's erasure-coded shard design): a small self-certifying-enough record published as an ordinary opaque core/data entry, naming which device holds which shard and how many are needed to reconstruct. The manifest deliberately carries NO key material and NO shard bytes -- a mailbox reading it learns only the distribution topology, and the encrypt-then- shard ordering means even a full set of shards without the epoch key is ciphertext.
 *
 * The entry encoding is plain canonical CDE CBOR (the same discipline every core/data application entry uses), with structural validation on both encode (self-check before publishing) and decode (a malformed or internally inconsistent manifest fails loudly rather than guiding a reader into reconstructing garbage).
 */

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import type { DeviceId } from "../generated/protocol.js";
import {
  decodeShards,
  encodeShards,
  type PresentedShard,
  type ShardConfig,
} from "./erasure-coding.js";

/** The content-type a core/data entry carrying a shard manifest declares. */
export const SHARD_MANIFEST_CONTENT_TYPE =
  "application/x-wire-mesh-shard-manifest";

/** Where one shard lives: the device holding it, and the bulk transfer that delivered it. */
export interface ShardLocation {
  device: DeviceId;
  "transfer-id": Uint8Array;
}

/** The manifest itself: N shards, any `threshold` of which reconstruct `original-length` bytes. */
export interface ShardManifest {
  "total-shards": number;
  threshold: number;
  /** The reconstructed content's own content-type (already suffixed if encrypted). */
  "content-type": string;
  /** The byte length the K shards reconstruct to -- the fact the shards cannot carry themselves (zero-padding is indistinguishable from a trailing zero byte). */
  "original-length": number;
  shards: ShardLocation[];
}

export function encodeShardManifest(
  manifest: Readonly<ShardManifest>,
): Uint8Array<ArrayBuffer> {
  validateManifest(manifest);
  return new Uint8Array(
    encode(
      {
        "total-shards": manifest["total-shards"],
        threshold: manifest.threshold,
        "content-type": manifest["content-type"],
        "original-length": manifest["original-length"],
        shards: manifest.shards.map((shard) => ({
          device: shard.device,
          "transfer-id": shard["transfer-id"],
        })),
      },
      cdeEncodeOptions,
    ),
  );
}

export function decodeShardManifest(entry: Uint8Array): ShardManifest {
  const decoded: unknown = decode(entry, cdeDecodeOptions);
  if (!isStringKeyedRecord(decoded)) {
    throw new Error("shard manifest entry is not a CBOR map");
  }

  const totalShards = decoded["total-shards"];
  const threshold = decoded.threshold;
  const contentType = decoded["content-type"];
  const originalLength = decoded["original-length"];
  const shards = decoded.shards;
  if (typeof totalShards !== "number" || typeof threshold !== "number") {
    throw new Error("shard manifest is missing numeric total-shards/threshold");
  }
  if (typeof contentType !== "string" || typeof originalLength !== "number") {
    throw new Error("shard manifest is missing content-type/original-length");
  }
  if (!Array.isArray(shards)) {
    throw new Error("shard manifest is missing its shards array");
  }
  const locations: ShardLocation[] = shards.map((raw) => {
    if (!isStringKeyedRecord(raw)) {
      throw new Error("shard manifest entry is malformed");
    }

    const device = raw.device;
    const transferId = raw["transfer-id"];
    if (
      !(device instanceof Uint8Array) ||
      !(transferId instanceof Uint8Array)
    ) {
      throw new Error(
        "shard manifest location is missing device/transfer-id bytes",
      );
    }
    // Fresh copies, the same whole-buffer discipline the identity adapters apply at runtime boundaries: cbor2's decoded views can cover a wider buffer.
    return {
      device: Uint8Array.from(device),
      "transfer-id": Uint8Array.from(transferId),
    };
  });
  const manifest: ShardManifest = {
    "total-shards": totalShards,
    threshold,
    "content-type": contentType,
    "original-length": originalLength,
    shards: locations,
  };
  validateManifest(manifest);
  return manifest;
}

/** The target for shard `index`, checked rather than asserted -- the length precondition above makes absence a caller bug worth a named error, not a silent undefined device. */
function targetFor(
  targets: readonly DeviceId[],
  index: number,
  shard: Uint8Array,
): DeviceId {
  const target = targets[index];
  if (target === undefined) {
    throw new Error(
      `no target device for shard ${String(index)} (${String(shard.length)} bytes)`,
    );
  }
  return target;
}

function isStringKeyedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateManifest(manifest: Readonly<ShardManifest>): void {
  if (manifest.shards.length !== manifest["total-shards"]) {
    throw new Error(
      `shard manifest declares ${String(manifest["total-shards"])} shards but lists ${String(manifest.shards.length)}`,
    );
  }
  if (manifest.threshold < 1 || manifest.threshold > manifest["total-shards"]) {
    throw new Error(
      `shard manifest threshold ${String(manifest.threshold)} must be between 1 and ${String(manifest["total-shards"])}`,
    );
  }
}

/** How a split names each transfer: the caller owns transfer-id allocation, same convention mintCapabilityToken applies to token-ids. */
export type NextTransferId = (shardIndex: number) => Uint8Array;

export interface SplitForShardedDeliveryOptions {
  config: Readonly<ShardConfig>;
  /** The content's own content-type -- already +aes256gcm-suffixed when the payload is encrypted (the usual case: encrypt first, then shard). */
  contentType: string;
  /** One target device per shard, in shard order; every shard needs a home. */
  targets: readonly DeviceId[];
  nextTransferId: NextTransferId;
}

export interface ShardedDelivery {
  manifest: ShardManifest;
  /** Shard i goes to targets[i] under transfer-id nextTransferId(i); the manifest records both. */
  shards: Uint8Array[];
  /** The manifest itself, encoded as a publishable core/data entry. */
  manifestEntry: Uint8Array<ArrayBuffer>;
}

/**
 * The sender half of the composition: split `payload` (already encrypted, when the content is secret -- encrypt-then-shard, so a single holder has neither enough pieces nor the key) into shards and build the manifest naming each shard's home. The bulk transfers themselves are the caller's policy (which sessions, when) -- this module owns the bytes and the manifest, the same primitive-vs-policy split data-sync itself draws.
 */
export async function splitForShardedDelivery(
  payload: Uint8Array,
  options: Readonly<SplitForShardedDeliveryOptions>,
): Promise<ShardedDelivery> {
  const { config, contentType, targets, nextTransferId } = options;
  if (targets.length < config.totalShards) {
    throw new Error(
      `every shard needs a home: ${String(config.totalShards)} shards but only ${String(targets.length)} targets`,
    );
  }
  const shards = await encodeShards(payload, {
    dataShards: config.dataShards,
    totalShards: config.totalShards,
  });
  const manifest: ShardManifest = {
    "total-shards": config.totalShards,
    threshold: config.dataShards,
    "content-type": contentType,
    "original-length": payload.length,
    shards: shards.map((shard, index) => ({
      device: targetFor(targets, index, shard),
      "transfer-id": nextTransferId(index),
    })),
  };
  validateManifest(manifest);
  return { manifest, shards, manifestEntry: encodeShardManifest(manifest) };
}

export interface ReconstructOptions {
  /** The decryption step, when the reconstructed bytes are ciphertext (the usual case). Applied AFTER reconstruction, never before -- decrypt-then-shard would expose plaintext to every shard holder. */
  decrypt?: (ciphertext: Uint8Array) => Promise<Uint8Array>;
}

/**
 * The reader half: any `threshold` shards plus the manifest reconstruct the payload -- and decrypt it, when a decryptor is given. Fails closed below the threshold (a mailbox holding fewer shards than the manifest names must not be able to read the content; that is the entire opacity property).
 */
export async function reconstructFromShards(
  fetched: readonly PresentedShard[],
  manifest: Readonly<ShardManifest>,
  options: Readonly<ReconstructOptions> = {},
): Promise<Uint8Array> {
  const reconstructed = await decodeShards(
    fetched,
    { dataShards: manifest.threshold, totalShards: manifest["total-shards"] },
    manifest["original-length"],
  );
  if (options.decrypt === undefined) {
    return reconstructed;
  }
  return options.decrypt(reconstructed);
}
