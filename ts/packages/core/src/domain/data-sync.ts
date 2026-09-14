/**
 * core/data sync protocol (spec/data-domain.cddl): the raw have/request/entries primitive over a KeyValueStorage-backed oplog. Deliberately scoped to this primitive alone, mirroring how mesh-session.ts's frame handling stays separate from an application's own dispatch policy -- when to proactively broadcast a data-have, which peers' logs to track at all, and how to fan a catch-up request out across several candidate holders are all application-level decisions this module has no opinion on. It only guarantees: appending to one's own log is correct and monotonic, and syncing another log via have/request/entries never accepts a gap.
 */

import type {
  DataEntriesFrame,
  DataHaveFrame,
  DataRequestFrame,
  DeviceId,
} from "../generated/protocol.js";
import type { IdentityPort } from "../ports/identity.js";
import type { KeyValueStorage } from "../ports/storage.js";
import { deviceIdToHex } from "./device-id.js";

function headKey(peer: DeviceId): string {
  return `data/${deviceIdToHex(peer)}/head`;
}

function entryKey(peer: DeviceId, seq: number): string {
  return `data/${deviceIdToHex(peer)}/entry/${String(seq)}`;
}

async function readHeadSeq(
  storage: Readonly<KeyValueStorage>,
  peer: DeviceId,
): Promise<number> {
  const raw = await storage.get(headKey(peer));
  if (raw === undefined) return 0;
  return Number(new TextDecoder().decode(raw));
}

async function writeHeadSeq(
  storage: Readonly<KeyValueStorage>,
  peer: DeviceId,
  seq: number,
): Promise<void> {
  await storage.set(headKey(peer), new TextEncoder().encode(String(seq)));
}

export interface DataSyncOptions {
  identity: IdentityPort;
  storage: KeyValueStorage;
}

/**
 * The current head-seq this store holds for `peer`'s log -- own log if peer is this device's own identity, a replicated peer's log otherwise (any store may hold and answer for a peer's log, per data-domain.cddl's own fan-out rule; nothing here distinguishes "my own log" from "a replica I'm holding"). 0 means nothing is held yet.
 */
export async function headSeqFor(
  storage: Readonly<KeyValueStorage>,
  peer: DeviceId,
): Promise<number> {
  return readHeadSeq(storage, peer);
}

/**
 * Appends one entry to this identity's own oplog and returns both the new sequence and the data-have frame announcing it. Only manages the local append and head-seq bookkeeping -- the caller decides when and to which peers to actually send the returned frame (proactively on every append, batched, on a timer, or not at all), the same "primitive vs. policy" split sendDirectManageRequest already draws for the manage-request path.
 */
export async function appendOwnEntry(
  options: Readonly<DataSyncOptions>,
  entry: Uint8Array<ArrayBuffer>,
): Promise<{ seq: number; haveFrame: DataHaveFrame }> {
  const currentHead = await readHeadSeq(
    options.storage,
    options.identity.deviceId,
  );
  const seq = currentHead + 1;
  await options.storage.set(entryKey(options.identity.deviceId, seq), entry);
  await writeHeadSeq(options.storage, options.identity.deviceId, seq);
  return {
    seq,
    haveFrame: {
      type: "data-have",
      peer: options.identity.deviceId,
      "head-seq": seq,
    },
  };
}

/**
 * Handles an incoming data-have: null if this store already holds `frame.peer`'s log up to or past the announced head-seq (nothing to do), otherwise the data-request that would catch it up from its own current head. Whether to actually send that request -- whether this store tracks `frame.peer`'s log at all -- is the caller's own policy; this function only ever answers "would catching up mean anything right now", never "do I want to".
 */
export async function handleDataHave(
  storage: Readonly<KeyValueStorage>,
  frame: Readonly<DataHaveFrame>,
): Promise<DataRequestFrame | null> {
  const ourHead = await readHeadSeq(storage, frame.peer);
  if (ourHead >= frame["head-seq"]) return null;
  return { type: "data-request", peer: frame.peer, "from-seq": ourHead };
}

/**
 * Handles an incoming data-request: the entries this store actually holds for `frame.peer` after `frame["from-seq"]`, capped at `limit`, or null if it holds none past that point. The responder need not be `frame.peer` itself -- any peer holding a replica may answer on the original author's behalf, per data-domain.cddl's own fan-out rule; this function makes no distinction.
 */
export async function handleDataRequest(
  storage: Readonly<KeyValueStorage>,
  frame: Readonly<DataRequestFrame>,
  limit: number,
): Promise<DataEntriesFrame | null> {
  const ourHead = await readHeadSeq(storage, frame.peer);
  if (ourHead <= frame["from-seq"]) return null;
  const lastSeq = Math.min(ourHead, frame["from-seq"] + limit);
  const entries: Uint8Array<ArrayBuffer>[] = [];
  for (let seq = frame["from-seq"] + 1; seq <= lastSeq; seq += 1) {
    const entry = await storage.get(entryKey(frame.peer, seq));
    if (entry === undefined) {
      // A hole in this store's own records for a range headSeqFor claims it holds -- shouldn't happen if entryKey/headKey stay consistent, but stop rather than send a data-entries frame with a silent gap a receiver's own check would only catch after the fact.
      break;
    }
    entries.push(entry);
  }
  if (entries.length === 0) return null;
  return {
    type: "data-entries",
    peer: frame.peer,
    "from-seq": frame["from-seq"],
    entries,
  };
}

export type HandleDataEntriesResult =
  { ok: true } | { ok: false; reason: "gap" };

/**
 * Handles an incoming data-entries: persists the given entries starting right after from-seq, but ONLY when from-seq exactly matches this store's own current head for `frame.peer` -- data-domain.cddl's own gap-rejection obligation. A mismatch covers both directions: from-seq ahead of our head is a real gap (we're missing something in between); from-seq behind our head is a stale or replayed response we've already applied. Either way the caller's own retry path is the same -- re-issue a data-request from this store's own current headSeqFor(peer), which handleDataHave already computes correctly on the next data-have it sees.
 */
export async function handleDataEntries(
  storage: Readonly<KeyValueStorage>,
  frame: Readonly<DataEntriesFrame>,
): Promise<HandleDataEntriesResult> {
  const ourHead = await readHeadSeq(storage, frame.peer);
  if (frame["from-seq"] !== ourHead) {
    return { ok: false, reason: "gap" };
  }
  let seq = frame["from-seq"];
  for (const entry of frame.entries) {
    seq += 1;
    await storage.set(entryKey(frame.peer, seq), entry);
  }
  await writeHeadSeq(storage, frame.peer, seq);
  return { ok: true };
}

/**
 * Entries this store holds for `peer` after `fromSeqExclusive`, in sequence order -- the local read-side counterpart to appendOwnEntry/handleDataEntries, for a caller replaying a log directly (e.g. an application rendering history) rather than syncing it over the wire.
 */
export async function readEntries(
  storage: Readonly<KeyValueStorage>,
  peer: DeviceId,
  fromSeqExclusive: number,
): Promise<Uint8Array[]> {
  const head = await readHeadSeq(storage, peer);
  const entries: Uint8Array[] = [];
  for (let seq = fromSeqExclusive + 1; seq <= head; seq += 1) {
    const entry = await storage.get(entryKey(peer, seq));
    if (entry === undefined) break;
    entries.push(entry);
  }
  return entries;
}
