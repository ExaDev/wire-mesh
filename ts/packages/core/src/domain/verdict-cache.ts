/* A byte-budgeted least-recently-used memo of boolean verdicts, for checks that are pure functions of the bytes they were given. Kept separate from peer-advert.ts so the eviction policy has one home and is testable without a signature in sight. */

/** Characters appended to a key's byte length when charging an entry to the budget: the cached promise and the map slot are not free, so an entry of zero key bytes still costs something. Sized as one pointer pair on a 64-bit runtime. */
const ENTRY_OVERHEAD_BYTES = 16;

/** The most characters String.fromCharCode may be given as arguments in one call without overflowing an engine's argument limit. */
const FROM_CHAR_CODE_CHUNK = 4096;

/**
 * A string that is equal for two byte sequences exactly when the sequences are equal: one character per byte, so a Map can key on it without hashing or comparing byte arrays itself.
 */
export function bytesKey(...parts: readonly Uint8Array[]): string {
  let key = "";
  for (const part of parts) {
    // The length prefix keeps (a, b) distinct from (a', b') when the concatenated bytes coincide, so a signature and a message can never be shifted against each other to collide.
    key += `${String(part.length)}:`;
    for (let start = 0; start < part.length; start += FROM_CHAR_CODE_CHUNK) {
      key += String.fromCharCode(
        ...part.subarray(start, start + FROM_CHAR_CODE_CHUNK),
      );
    }
  }

  return key;
}

/** A memo of in-flight and settled verdicts keyed by an opaque string. */
export interface VerdictCache {
  /**
   * The verdict for `key`, computing it with `compute` only when no live entry holds one. A concurrent caller for the same key shares the first caller's computation rather than starting another.
   *
   * `compute` resolves to a verdict to remember, or to `undefined` when the outcome was an error that a later attempt might not repeat: that outcome is returned to every waiting caller as `false` (the check did not succeed) but is not kept, so a transient failure is retried instead of being remembered as a refusal.
   */
  verdict: (
    key: string,
    compute: () => Promise<boolean | undefined>,
  ) => Promise<boolean>;
}

/**
 * Builds a memo whose entries together never charge more than `budgetBytes`. The least recently used entry goes first when a new one would overflow; a key larger than the whole budget is computed but never kept, so one hostile oversized input cannot flush everything else.
 */
export function createVerdictCache(budgetBytes: number): VerdictCache {
  const entries = new Map<
    string,
    { settled: Promise<boolean>; cost: number }
  >();
  let used = 0;

  const forget = (key: string): void => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return;
    }
    entries.delete(key);
    used -= entry.cost;
  };

  return {
    async verdict(key, compute) {
      const held = entries.get(key);
      if (held !== undefined) {
        // Re-inserted so Map iteration order is recency order.
        entries.delete(key);
        entries.set(key, held);

        return held.settled;
      }
      const cost = key.length + ENTRY_OVERHEAD_BYTES;
      const settled = compute().then((outcome) => {
        if (outcome === undefined) {
          forget(key);

          return false;
        }

        return outcome;
      });
      if (cost > budgetBytes) {
        return settled;
      }
      entries.set(key, { settled, cost });
      used += cost;
      for (const oldest of entries.keys()) {
        if (used <= budgetBytes) {
          break;
        }
        forget(oldest);
      }

      return settled;
    },
  };
}
