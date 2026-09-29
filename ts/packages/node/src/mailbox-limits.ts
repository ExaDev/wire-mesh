// What a node started with --mailbox-dir will hold, so a directory an operator points it at cannot grow without bound. These are ceilings for a node on someone's own disk, not tuned figures: the worst case is MAX_LOGS times MAX_LOG_BYTES, about 4 GiB, which is what the directory can reach.

import type { MailboxLimits } from "wire-mesh-core/domain/hub-mailbox";

const BYTES_PER_KIB = 1024;
const KIB_PER_MIB = 1024;

const MAX_LOGS = 64;
const MAX_LOG_MIB = 64;
const MAX_ENTRY_KIB = 512;
const READ_BATCH = 64;

export const nodeMailboxLimits: MailboxLimits = {
  maxLogs: MAX_LOGS,
  maxLogBytes: MAX_LOG_MIB * KIB_PER_MIB * BYTES_PER_KIB,
  maxEntryBytes: MAX_ENTRY_KIB * BYTES_PER_KIB,
  readBatch: READ_BATCH,
};
