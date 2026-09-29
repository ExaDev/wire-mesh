// What this hub's mailbox holds, and how much. The hub's Durable Object is SQLite-backed, whose storage is 10 GB per object (https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/), and stored data is billed by the gigabyte-month, so the limits keep the worst case a small fraction of that and put the ceiling in one place: MAILBOX_BUDGET_BYTES.

import type { MailboxLimits } from "wire-mesh-core/domain/hub-mailbox";

const BYTES_PER_KIB = 1024;
const KIB_PER_MIB = 1024;
const MIB_PER_GIB = 1024;

/** The most the mailbox may hold in all: one gibibyte, a tenth of the storage one Durable Object is given. */
export const MAILBOX_BUDGET_BYTES = MIB_PER_GIB * KIB_PER_MIB * BYTES_PER_KIB;

/** How many devices' logs may be held. Each may grow to MAILBOX_BUDGET_BYTES / MAILBOX_MAX_LOGS. */
const MAILBOX_MAX_LOGS = 256;

/** The size of one entry: the value-size limit of the key-value API on a key-value-backed Durable Object (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), the smallest limit the runtime documents for a stored value, so an entry that fits here fits under either backend. */
const VALUE_LIMIT_KIB = 128;
const MAILBOX_MAX_ENTRY_BYTES = VALUE_LIMIT_KIB * BYTES_PER_KIB;

/** How many entries one reply carries, so a reply stays within one message's worth of the log. */
const MAILBOX_READ_BATCH = 32;

export const mailboxLimits: MailboxLimits = {
  maxLogs: MAILBOX_MAX_LOGS,
  maxLogBytes: MAILBOX_BUDGET_BYTES / MAILBOX_MAX_LOGS,
  maxEntryBytes: MAILBOX_MAX_ENTRY_BYTES,
  readBatch: MAILBOX_READ_BATCH,
};
