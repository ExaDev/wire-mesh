/**
 * Consumer wiring for redundant erasure-coded shard distribution (wire-mesh#161), composing #158's erasure coding, #159's shard manifest, and core/bulk's own resumable transfer -- every one of which is already complete and independently tested -- into the three roles a genuine mailbox topology needs: a sender pushing each shard to its manifest-named holder device over an ordinary core/bulk transfer and publishing the manifest to its own core/data log; a holder (mailbox) durably accepting a shard and able to re-serve it to a later requester; and a reader gathering back any `threshold` of the `total-shards` shards and reconstructing (decrypting, when a decryptor is given) the original payload.
 *
 * Every wire interaction here is an ordinary bulk.open/bulk-data/bulk-end push or an ordinary core/data append -- no new frame kinds, matching #34's own "redundant shard distribution needs no new wire shapes" design note. WHEN a holder re-serves a shard it already accepted to a specific requester is deliberately left to the caller (serveShard is an explicit call, not a standing policy this module runs on its own), the same primitive-vs-policy split data-sync.ts and notice-board.ts already draw for their own "the caller decides when to actually send" boundaries. Confidentiality is likewise out of this module's hands: shard-manifest.ts's own header comment already establishes that a holder -- or a reader who only ever gathers shard bytes without the epoch key -- learns nothing beyond ciphertext; access to the shard bytes themselves is not a security boundary this design relies on.
 */

import type {
  CapabilityScope,
  DataHaveFrame,
  DeviceId,
  Frame,
} from "../generated/protocol.js";
import type { Connection } from "../ports/transport.js";
import type { IdentityPort } from "../ports/identity.js";
import type { KeyValueStorage } from "../ports/storage.js";
import type { MeshSession } from "./mesh-session.js";
import { appendOwnEntry, readEntries } from "./data-sync.js";
import {
  createBulkReceiver,
  createBulkSender,
  storedTransferSource,
  type BulkOfferEvent,
  type BulkReceiveResult,
  type BulkReceiver,
  type BulkSendOutcome,
} from "./bulk.js";
import {
  decodeShardManifest,
  reconstructFromShards,
  splitForShardedDelivery,
  type NextTransferId,
  type ShardManifest,
} from "./shard-manifest.js";
import type { PresentedShard, ShardConfig } from "./erasure-coding.js";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function readStoredTransferBytes(
  storage: Readonly<KeyValueStorage>,
  transferId: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const source = storedTransferSource({ storage, transferId });
  const chunks: Uint8Array[] = [];
  for await (const chunk of source(0)) {
    chunks.push(chunk);
  }
  return concat(chunks);
}

/** Wraps `chunk` as a CreateBulkSenderOptions.source yielding it whole, exactly once -- a shard is already one complete piece of bytes by the time splitForShardedDelivery hands it back, so pushing it needs no further chunking of its own; core/bulk's own multi-chunk flow control is already exercised by bulk.ts's own tests. */
function singleChunkSource(
  chunk: Uint8Array<ArrayBuffer>,
): (fromSeq: number) => AsyncIterable<Uint8Array<ArrayBuffer>> {
  return (fromSeq: number) => ({
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array<ArrayBuffer>> {
      let exhausted = fromSeq > 0;
      return {
        next: async (): Promise<IteratorResult<Uint8Array<ArrayBuffer>>> => {
          if (exhausted)
            return Promise.resolve({ value: undefined, done: true });
          exhausted = true;
          return Promise.resolve({ value: chunk, done: false });
        },
      };
    },
  });
}

/** Pumps a connection's own incoming frames into a bulk sender's onFrame (bulk-ack) for as long as the connection stays open, calling onConnectionEnd once it doesn't -- the same wiring bulk.ts's own doc comment asks any caller pushing over a live connection to provide. */
function pumpSenderAcks(
  connection: Readonly<Connection>,
  sender: Readonly<{
    onFrame: (connection: Readonly<Connection>, frame: Frame) => void;
    onConnectionEnd: (connection: Readonly<Connection>) => void;
  }>,
): void {
  void (async (): Promise<void> => {
    for await (const frame of connection.receive()) {
      sender.onFrame(connection, frame);
    }
    sender.onConnectionEnd(connection);
  })();
}

// ---------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------

/** One already-established, already-authenticated connection+session this module pushes a shard over -- establishing and authenticating it (discovery, handshake, whatever reconnect policy applies) is the caller's own job, mirroring every other domain module here (notice-board.ts, capability-request.ts) that takes a live MeshSession rather than owning connection setup itself. */
export interface ShardChannel {
  connection: Readonly<Connection>;
  session: Readonly<MeshSession>;
}

export interface DistributeShardedPayloadOptions {
  config: Readonly<ShardConfig>;
  /** The payload's own content-type -- already +aes256gcm-suffixed when encrypted, matching splitForShardedDelivery's own convention (encrypt-then-shard, never the reverse). */
  contentType: string;
  /** One target holder device per shard, in shard order -- splitForShardedDelivery's own targets contract, unchanged. */
  targets: readonly DeviceId[];
  /** One channel per shard, aligned by index with `targets`: channels[i] is the connection this sender pushes shard i over, addressed to targets[i]. */
  channels: readonly ShardChannel[];
  nextTransferId: NextTransferId;
  scope: Readonly<CapabilityScope>;
  /** This sender's own identity -- the manifest is published to its own core/data log (appendOwnEntry), per #34's "manifest as an ordinary opaque core/data entry" design. */
  identity: IdentityPort;
  storage: KeyValueStorage;
}

export interface DistributedShardedPayload {
  manifest: ShardManifest;
  manifestEntry: Uint8Array<ArrayBuffer>;
  /** The data-have frame announcing the manifest's new log entry -- the caller decides when and to whom to actually send it, matching appendOwnEntry's own "primitive vs policy" split. */
  dataHave: DataHaveFrame;
  /** Per-shard bulk send outcomes, in shard order -- a caller inspecting for anything other than "complete" knows which specific holder(s) didn't durably receive their shard on this attempt. */
  outcomes: readonly BulkSendOutcome[];
}

/**
 * Splits `payload` into shards, pushes each one to its manifest-named target device over an ordinary core/bulk transfer, and publishes the resulting manifest to this sender's own core/data log. Every shard push runs concurrently (each is an independent transfer, per #34's own design note), so one holder being slow or offline never blocks another's delivery; the manifest is published once every push has settled (successfully or not), since the manifest is only useful once it truthfully names where every shard actually went.
 */
export async function distributeShardedPayload(
  payload: Uint8Array,
  options: Readonly<DistributeShardedPayloadOptions>,
): Promise<DistributedShardedPayload> {
  const {
    config,
    contentType,
    targets,
    channels,
    nextTransferId,
    scope,
    identity,
    storage,
  } = options;
  if (channels.length < config.totalShards) {
    throw new Error(
      `every shard needs a channel to push over: ${String(config.totalShards)} shards but only ${String(channels.length)} channels`,
    );
  }

  const { manifest, shards, manifestEntry } = await splitForShardedDelivery(
    payload,
    {
      config,
      contentType,
      targets,
      nextTransferId,
    },
  );

  const outcomes = await Promise.all(
    shards.map(async (shard, index): Promise<BulkSendOutcome> => {
      const channel = channels[index];
      const location = manifest.shards[index];
      if (channel === undefined || location === undefined) {
        throw new Error(`no channel/manifest entry for shard ${String(index)}`);
      }
      // Fresh copies, the same whole-buffer discipline shard-manifest.ts's own decodeShardManifest already applies: splitForShardedDelivery's shards/transfer-id fields are typed as plain Uint8Array (ArrayBufferLike-backed), while core/bulk's own sender API is typed against the stricter Uint8Array<ArrayBuffer> throughout.
      const shardBytes = Uint8Array.from(shard);
      const transferId = Uint8Array.from(location["transfer-id"]);
      const sender = createBulkSender({
        source: singleChunkSource(shardBytes),
      });
      pumpSenderAcks(channel.connection, sender);
      return sender.open(channel.connection, channel.session, scope, {
        transferId,
        targetDevice: location.device,
        contentType: manifest["content-type"],
        totalSize: shardBytes.length,
      });
    }),
  );

  const { haveFrame: dataHave } = await appendOwnEntry(
    { identity, storage },
    manifestEntry,
  );
  return { manifest, manifestEntry, dataHave, outcomes };
}

// ---------------------------------------------------------------------
// Holder (mailbox)
// ---------------------------------------------------------------------

export interface ShardHolderOptions {
  storage: KeyValueStorage;
}

export interface ShardHolder {
  /** Handles bulk-data/bulk-end frames for shards this holder has accepted -- an ordinary BulkReceiver's own onFrame; wire it the same way. */
  onFrame: BulkReceiver["onFrame"];
  /** Builds the manage-request handler for an incoming bulk.open asking this holder to store a shard -- an ordinary BulkReceiver's own createOpenHandler, exposed unchanged so a caller wires it exactly like any other bulk:write handler. */
  createOpenHandler: BulkReceiver["createOpenHandler"];
  /** Re-serves a shard this holder already durably accepted to a fresh requester over `channel` -- the fetch half of consumer wiring. WHEN to call this (a reader connecting, an authenticated ask, a standing "serve on connect" policy) is the caller's own decision; this only owns actually pushing the bytes once that decision is made, reading them back via storedTransferSource rather than requiring the caller to have kept anything else around. */
  serveShard: (
    channel: Readonly<ShardChannel>,
    transferId: Uint8Array<ArrayBuffer>,
    targetDevice: DeviceId,
    scope: Readonly<CapabilityScope>,
    serveOptions?: Readonly<{ contentType?: string; totalSize?: number }>,
  ) => Promise<BulkSendOutcome>;
}

/**
 * Builds a holder (mailbox) role over one KeyValueStorage: an ordinary BulkReceiver for accepting shards pushed to it, plus the ability to re-serve a previously-accepted shard on demand. One holder is constructed per storage, the same "constructed once, shared across every connection this side accepts" convention createBulkReceiver itself already documents.
 */
export function createShardHolder(
  options: Readonly<ShardHolderOptions>,
): ShardHolder {
  const { storage } = options;
  const receiver = createBulkReceiver({ storage });
  return {
    onFrame: receiver.onFrame,
    createOpenHandler: receiver.createOpenHandler,
    async serveShard(
      channel,
      transferId,
      targetDevice,
      scope,
      serveOptions = {},
    ) {
      const sender = createBulkSender({
        source: storedTransferSource({ storage, transferId }),
      });
      pumpSenderAcks(channel.connection, sender);
      return sender.open(channel.connection, channel.session, scope, {
        transferId,
        targetDevice,
        ...(serveOptions.contentType !== undefined
          ? { contentType: serveOptions.contentType }
          : {}),
        ...(serveOptions.totalSize !== undefined
          ? { totalSize: serveOptions.totalSize }
          : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------

export interface CreateShardCollectorOptions {
  manifest: Readonly<ShardManifest>;
  storage: KeyValueStorage;
  /** The decryption step, applied after reconstruction -- see reconstructFromShards' own ReconstructOptions.decrypt. Omit when the payload was never encrypted. */
  decrypt?: (ciphertext: Uint8Array) => Promise<Uint8Array>;
}

export interface ShardCollector {
  /** Shared across every holder connection this reader accepts a shard offer over -- one BulkReceiver, the same "constructed once" convention createBulkReceiver's own doc comment establishes, since durable per-transfer state must outlive any one connection. */
  receiver: BulkReceiver;
  /**
   * Builds the onOffer callback for the shard at `index` in `manifest.shards` -- bind once per holder connection (via receiver.createOpenHandler(holderDevice, connection, onOfferForIndex(index))). Accepts an offer only when its transfer-id genuinely matches the manifest's own entry for that index (the manifest is the sole authority on which transfer-id belongs to which shard slot; an offer naming anything else is refused outright, never guessed at). Once `manifest.threshold` distinct shard indices have completed, the collector reconstructs (and decrypts, if given a decryptor) and settles `result` -- any shard finishing after that point is still durably stored by the underlying receiver but no longer affects the outcome.
   */
  onOfferForIndex: (index: number) => (event: Readonly<BulkOfferEvent>) => void;
  /** Resolves once `manifest.threshold` shards have completed and been reconstructed (and decrypted, if a decryptor was given); rejects if reconstruction/decryption itself fails once that threshold is reached. */
  result: Promise<Uint8Array>;
}

/**
 * Builds the reader-side collector: given a manifest, gathers back any `threshold` of its shards and reconstructs (and decrypts) the original payload. The caller owns establishing a connection to each holder device it chooses to try (any threshold-or-more of the manifest's named holders suffices; the collector itself has no opinion on which ones, or how many beyond the minimum, a caller attempts) and wiring each one's incoming bulk.open asks to the returned onOfferForIndex -- this module owns only the accept-or-reject policy and the reconstruction once enough have landed.
 */
export function createShardCollector(
  options: Readonly<CreateShardCollectorOptions>,
): ShardCollector {
  const { manifest, storage, decrypt } = options;
  const receiver = createBulkReceiver({ storage });
  const presented = new Map<number, Uint8Array>();
  let settled = false;
  let resolveResult: (value: Uint8Array) => void = () => undefined;
  let rejectResult: (error: Error) => void = () => undefined;
  const result = new Promise<Uint8Array>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  function maybeFinish(): void {
    if (settled || presented.size < manifest.threshold) return;
    settled = true;
    const chosen: PresentedShard[] = [...presented.entries()]
      .slice(0, manifest.threshold)
      .map(([index, data]) => ({ index, data }));
    reconstructFromShards(
      chosen,
      manifest,
      decrypt === undefined ? {} : { decrypt },
    )
      .then(resolveResult)
      .catch((error: unknown) => {
        rejectResult(error instanceof Error ? error : new Error(String(error)));
      });
  }

  return {
    receiver,
    onOfferForIndex(index: number) {
      return (event: Readonly<BulkOfferEvent>) => {
        const location = manifest.shards[index];
        if (
          location === undefined ||
          !bytesEqual(event.transferId, location["transfer-id"])
        ) {
          void event.decide({
            kind: "reject",
            reason: "shard offer does not match the manifest",
          });
          return;
        }
        void event.decide({
          kind: "accept",
          window: event.totalSize ?? manifest["original-length"],
          onComplete: (completion: Readonly<BulkReceiveResult>) => {
            if (settled || !completion.ok) return;
            readStoredTransferBytes(
              storage,
              Uint8Array.from(location["transfer-id"]),
            )
              .then((data) => {
                presented.set(index, data);
                maybeFinish();
              })
              .catch((error: unknown) => {
                rejectResult(
                  error instanceof Error ? error : new Error(String(error)),
                );
              });
          },
        });
      };
    },
    result,
  };
}

export interface LocateShardManifestsOptions {
  storage: KeyValueStorage;
  /** The device whose core/data log to scan -- the manifest's own publisher (distributeShardedPayload's own `identity.deviceId`). Replicating that log into `storage` in the first place is ordinary data-sync policy, out of scope here. */
  publisher: DeviceId;
}

/**
 * Scans `publisher`'s core/data log for entries that parse as a structurally valid shard manifest, oldest first. A log holds arbitrary application entries; decodeShardManifest's own structural validation is what tells a manifest apart from anything else the same publisher posted there -- an entry that merely happens to fail that validation is skipped rather than treated as an error, the same "malformed/unrecognised entries don't abort the scan" convention notice-board.ts's own decodeNotice already follows.
 */
export async function locateShardManifests(
  options: Readonly<LocateShardManifestsOptions>,
): Promise<ShardManifest[]> {
  const { storage, publisher } = options;
  const entries = await readEntries(storage, publisher, 0);
  const manifests: ShardManifest[] = [];
  for (const entry of entries) {
    try {
      manifests.push(decodeShardManifest(entry));
    } catch {
      // Not a shard manifest -- some other application entry in the same log.
    }
  }
  return manifests;
}
