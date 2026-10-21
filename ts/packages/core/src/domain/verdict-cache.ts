/* A byte-budgeted least-recently-used memo of boolean verdicts, for checks that are pure functions of the bytes they were given. Kept separate from peer-advert.ts so the eviction policy has one home and is testable without a signature in sight. */

/** Characters appended to a key's byte length when charging an entry to the budget: the cached promise and the map slot are not free, so an entry of zero key bytes still costs something. Sized as one pointer pair on a 64-bit runtime. */
const ENTRY_OVERHEAD_BYTES = 16;

/** The most characters String.fromCharCode may be given as arguments in one call without overflowing an engine's argument limit. */
const FROM_CHAR_CODE_CHUNK = 4096;

/**
 * How many characters bytesKey produces for these parts: each part's length in decimal, a colon, then one character per byte. Computed from the lengths alone, so a caller can refuse an oversized input before any character of its key exists.
 */
export function bytesKeyLength(parts: readonly Uint8Array[]): number {
  let length = 0;
  for (const part of parts) {
    length += String(part.length).length + 1 + part.length;
  }

  return length;
}

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
   * The verdict for the bytes in `parts`, computing it with `compute` only when no live entry holds one. A concurrent caller for the same bytes shares the first caller's computation rather than starting another.
   *
   * The key is built from `parts` only when the entry would fit the budget, counting the keys of verdicts still being computed: an input that would not fit is computed and never keyed, so neither one attacker-sized input nor many concurrent ones cost more than computing their verdicts directly, with no copy of them as strings.
   *
   * `compute` resolves to a verdict to remember, or to `undefined` when the outcome was an error that a later attempt might not repeat: that outcome is returned to every waiting caller as `false` (the check did not succeed) but is not kept, so a transient failure is retried instead of being remembered as a refusal.
   */
  verdict: (
    parts: readonly Uint8Array[],
    compute: () => Promise<boolean | undefined>,
  ) => Promise<boolean>;
}

/** An outcome that was not kept: the check's verdict, or false when it did not reach one. */
async function unsettledAsRefusal(
  compute: () => Promise<boolean | undefined>,
): Promise<boolean> {
  return (await compute()) ?? false;
}

/**
 * Builds a memo whose entries together never charge more than `budgetBytes`. The least recently used entry goes first when a new one would overflow; an input whose key is larger than the whole budget is computed but never kept, so one hostile oversized input cannot flush everything else.
 */
export function createVerdictCache(budgetBytes: number): VerdictCache {
  const entries = new Map<
    string,
    { settled: Promise<boolean>; cost: number }
  >();
  let used = 0;
  /** Key bytes charged to verdicts still being computed. An entry evicted while its verdict is pending is gone from `entries`, but the computation still holds its key until it settles, so `used` alone would let many concurrent large inputs each keep a key the budget no longer sees. */
  let pending = 0;

  const forget = (key: string): void => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return;
    }
    entries.delete(key);
    used -= entry.cost;
  };

  return {
    async verdict(parts, compute) {
      const cost = bytesKeyLength(parts) + ENTRY_OVERHEAD_BYTES;
      if (cost > budgetBytes) {
        return unsettledAsRefusal(compute);
      }
      if (pending + cost > budgetBytes) {
        // The keys of verdicts still being computed already fill the budget, so this input is verified directly rather than keyed. A repeat of a held input is then recomputed too, which only costs the verification the cache would have saved.
        return unsettledAsRefusal(compute);
      }
      const key = bytesKey(...parts);
      const held = entries.get(key);
      if (held !== undefined) {
        // Re-inserted so Map iteration order is recency order.
        entries.delete(key);
        entries.set(key, held);

        return held.settled;
      }
      pending += cost;
      const settled = compute()
        .then((outcome) => {
          if (outcome === undefined) {
            forget(key);

            return false;
          }

          return outcome;
        })
        .finally(() => {
          pending -= cost;
        });
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
