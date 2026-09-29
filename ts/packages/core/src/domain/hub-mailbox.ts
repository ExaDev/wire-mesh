// The announcer role of a relay hub (discovery.cddl's mailboxes, data-domain.cddl): a replicator that holds other devices' `core/data` logs while those devices are offline, so a peer that reconnects later can catch up from the hub instead of waiting for the author to be back. It is an ordinary replicator of the primitive data-sync.ts already implements, with the one thing a replicator open to anyone needs that data-sync.ts leaves to its caller: who may write, and how much.
//
// Only the device that owns a log may write to it. The hub takes `data-have` and `data-entries` for a log from the connection whose verified advert names that device, and from no one else, so nobody can fill or poison another device's log; entries are opaque to it and the applications that write them sign and encrypt their own, which is what lets a reader trust what comes back. Any device the hub has an identity for may read a log: the directory it registers from is already open to every client, and what a log adds is metadata the entries' own encryption does not hide. Whether that stays open is the hub-directory decision (wire-mesh#260), not one made here.
//
// Bounded three ways, all set by the host: how many logs it holds, how many bytes any one log may grow to, and how large one entry may be. A frame that would exceed a bound is refused whole and nothing of it is kept, so a log never holds a prefix the writer believes it sent in full. Nothing is ever evicted: a full log stays full until the host clears it, and the writer learns of that only by its entries not being asked for.

import type {
  DataEntriesFrame,
  DataHaveFrame,
  DataRequestFrame,
  DeviceId,
  Frame,
} from "../generated/protocol.js";
import type { KeyValueStorage } from "../ports/storage.js";
import { deviceIdToHex } from "./device-id.js";
import {
  handleDataEntries,
  handleDataHave,
  handleDataRequest,
  headSeqFor,
} from "./data-sync.js";

export interface MailboxLimits {
  /** How many devices' logs the mailbox will hold at once. */
  readonly maxLogs: number;
  /** How many bytes of entries one log may hold in total. */
  readonly maxLogBytes: number;
  /** How large one entry may be. */
  readonly maxEntryBytes: number;
  /** How many entries one reply carries at most; a longer log takes more rounds. */
  readonly readBatch: number;
}

export interface MailboxOptions {
  readonly storage: KeyValueStorage;
  readonly limits: Readonly<MailboxLimits>;
}

/** Called for a data frame the mailbox refuses, so the host can report why; the sender is given no reply, since data-domain.cddl defines no error frame. */
export type MailboxRefusalReason =
  | "not-the-owner"
  | "unregistered-sender"
  | "log-limit"
  | "size-limit"
  | "entry-limit"
  | "gap";

export interface Mailbox {
  /**
   * Handles one data frame from a connection. `sender` is the device the hub has verified that connection to be, or undefined when it has not gossiped one. Returns the frame to send back, or null for none. `onRefused` is told when the frame was refused and why.
   */
  handle: (
    sender: DeviceId | undefined,
    frame: Readonly<DataHaveFrame | DataRequestFrame | DataEntriesFrame>,
    onRefused?: (reason: MailboxRefusalReason) => void,
  ) => Promise<Frame | null>;
}

/** The data frames a mailbox answers. */
export function isDataFrame(
  frame: Readonly<Frame>,
): frame is DataHaveFrame | DataRequestFrame | DataEntriesFrame {
  return (
    frame.type === "data-have" ||
    frame.type === "data-request" ||
    frame.type === "data-entries"
  );
}

const LOG_COUNT_KEY = "mailbox/log-count";

function logBytesKey(peer: DeviceId): string {
  return `mailbox/${deviceIdToHex(peer)}/bytes`;
}

function encodeCount(value: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(String(value));
}

async function readCount(
  storage: Readonly<KeyValueStorage>,
  key: string,
): Promise<number> {
  const raw = await storage.get(key);
  return raw === undefined ? 0 : Number(new TextDecoder().decode(raw));
}

function sameDevice(a: Readonly<DeviceId>, b: Readonly<DeviceId>): boolean {
  return deviceIdToHex(a) === deviceIdToHex(b);
}

export function createMailbox(options: Readonly<MailboxOptions>): Mailbox {
  const { storage, limits } = options;

  async function handleHave(
    sender: DeviceId,
    frame: Readonly<DataHaveFrame>,
    refuse: (reason: MailboxRefusalReason) => void,
  ): Promise<Frame | null> {
    if (!sameDevice(sender, frame.peer)) {
      refuse("not-the-owner");
      return null;
    }
    if ((await headSeqFor(storage, frame.peer)) === 0) {
      if ((await readCount(storage, LOG_COUNT_KEY)) >= limits.maxLogs) {
        refuse("log-limit");
        return null;
      }
    }
    return handleDataHave(storage, frame);
  }

  async function handleEntries(
    sender: DeviceId,
    frame: Readonly<DataEntriesFrame>,
    refuse: (reason: MailboxRefusalReason) => void,
  ): Promise<Frame | null> {
    if (!sameDevice(sender, frame.peer)) {
      refuse("not-the-owner");
      return null;
    }
    if (frame.entries.some((entry) => entry.length > limits.maxEntryBytes)) {
      refuse("size-limit");
      return null;
    }
    const held = await readCount(storage, logBytesKey(frame.peer));
    const added = frame.entries.reduce((sum, entry) => sum + entry.length, 0);
    if (held + added > limits.maxLogBytes) {
      refuse("entry-limit");
      return null;
    }
    const isNewLog = (await headSeqFor(storage, frame.peer)) === 0;
    if (
      isNewLog &&
      (await readCount(storage, LOG_COUNT_KEY)) >= limits.maxLogs
    ) {
      refuse("log-limit");
      return null;
    }
    const stored = await handleDataEntries(storage, frame);
    if (!stored.ok) {
      refuse("gap");
      return null;
    }
    await storage.set(logBytesKey(frame.peer), encodeCount(held + added));
    if (isNewLog && frame.entries.length > 0) {
      await storage.set(
        LOG_COUNT_KEY,
        encodeCount((await readCount(storage, LOG_COUNT_KEY)) + 1),
      );
    }
    return null;
  }

  return {
    async handle(sender, frame, onRefused) {
      const refuse = (reason: MailboxRefusalReason): void => {
        onRefused?.(reason);
      };
      if (sender === undefined) {
        refuse("unregistered-sender");
        return null;
      }
      if (frame.type === "data-have") return handleHave(sender, frame, refuse);
      if (frame.type === "data-entries") {
        return handleEntries(sender, frame, refuse);
      }
      return handleDataRequest(storage, frame, limits.readBatch);
    },
  };
}
