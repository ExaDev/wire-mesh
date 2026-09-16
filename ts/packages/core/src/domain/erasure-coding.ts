/**
 * K-of-N erasure coding over GF(2^8) for wire-mesh#36's mailbox-opacity case (the shard half of #34's encrypt-then-shard design): a systematic Reed-Solomon construction where the first `dataShards` shards ARE the padded input split into equal runs, and the remaining shards are parity rows of a Vandermonde-style matrix. Any `dataShards` of `totalShards` reconstruct the input -- the property a single mailbox holder must NOT have (it holds one shard and never the epoch key either).
 *
 * Deliberately hand-written rather than a dependency, the same choice the ECIES construction made: the encode format must be byte-identical across this and the Rust implementation, so both pin the SAME vectors against the documented construction rather than trusting two third-party ports to agree. The math is linear algebra over GF(2^8) with the standard 0x11d polynomial (AES's field), not cryptography.
 *
 * The construction, pinned: pad the input with zero bytes to dataShards * ceil(len / dataShards); any shard index below dataShards is that shard's own equal run; parity shard j (0-based within the parity block) has, at each byte position, the GF dot product of the data runs at that position with the coefficient row (alpha^j, alpha^(j+1), ..., alpha^(j+dataShards-1)) where alpha = 0x02 (the field's generator). Decoding: build the dataShards x dataShards submatrix of the full encode matrix selected by the surviving shards' row indices, invert it over the field, and apply it to the surviving shards' bytes. The encode matrix's first dataShards rows are the identity (systematic), so the all-data-shards case needs no inversion at all.
 */

/** The AES field's irreducible polynomial x^8+x^4+x^3+x+1, the conventional GF(2^8) choice. */
const GF_POLY = 0x11d;
/** The bit that appears when a GF(2^8) value overflows a byte and needs the polynomial reduction. */
const GF_OVERFLOW_BIT = 0x100;
/** GF(2^8) caps total shards at 255 (a 256th row would repeat, breaking invertibility). */
const GF_MAX_SHARDS = 255;

export interface ShardConfig {
  dataShards: number;
  totalShards: number;
}

// Plain arrays, not Uint8Array: every element is written before any read (the init loop below), and plain number[] keeps indexed access total under noUncheckedIndexedAccess without a scatter of non-null assertions.
const gfExp: number[] = Array.from({ length: 2 * GF_MAX_SHARDS }, () => 0);
const gfLog: number[] = Array.from({ length: GF_MAX_SHARDS + 1 }, () => 0);
{
  let x = 1;
  for (let power = 0; power < GF_MAX_SHARDS; power += 1) {
    gfExp[power] = x;
    gfLog[x] = power;
    // Multiply by the generator in this field: shift, then reduce by the polynomial when the high bit appears.
    x <<= 1;
    if (x & GF_OVERFLOW_BIT) {
      x ^= GF_POLY;
    }
  }
  // The second half lets gfExp[a+b] index past 255 without a modulo.
  for (let power = GF_MAX_SHARDS; power < 2 * GF_MAX_SHARDS; power += 1) {
    gfExp[power] = gfExp[power - GF_MAX_SHARDS] ?? 0;
  }
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return gfExp[(gfLog[a] ?? 0) + (gfLog[b] ?? 0)] ?? 0;
}

function gfInv(a: number): number {
  return gfExp[GF_MAX_SHARDS - (gfLog[a] ?? 0)] ?? 1;
}

function validateConfig(config: Readonly<ShardConfig>): void {
  const { dataShards, totalShards } = config;
  if (!Number.isInteger(dataShards) || dataShards < 1) {
    throw new Error(
      `dataShards must be a positive integer, got ${String(dataShards)}`,
    );
  }
  if (!Number.isInteger(totalShards) || totalShards < dataShards) {
    throw new Error(
      `totalShards must be an integer at least dataShards (${String(dataShards)}), got ${String(totalShards)}`,
    );
  }
  if (totalShards > GF_MAX_SHARDS) {
    throw new Error(
      `the GF(2^8) field supports at most ${String(GF_MAX_SHARDS)} shards, got ${String(totalShards)}`,
    );
  }
}

/** Row i of the encode matrix: identity rows for the data shards, alpha-power rows for parity. */
/**
 * Row i of the encode matrix: identity rows for the data shards, Cauchy rows for parity. Cauchy, not Vandermonde, because only Cauchy guarantees EVERY square submatrix is invertible -- identity-plus-Vandermonde has singular K-subsets (found the hard way: parity-based reconstruction produced wrong bytes on some subsets). With parity row j carrying c_i = 1/(x_j XOR y_i) where x_j = row and y_i = column (all row/column values distinct across the whole matrix, no parity row index equals any data column index, so no denominator is zero), any K surviving rows reduce -- expanding along the identity rows -- to a square Cauchy submatrix, always invertible.
 */
function encodeMatrixRow(row: number, dataShards: number): number[] {
  const coefficients: number[] = Array.from({ length: dataShards }, () => 0);
  if (row < dataShards) {
    coefficients[row] = 1;
    return coefficients;
  }
  for (let column = 0; column < dataShards; column += 1) {
    coefficients[column] = gfInv(row ^ column);
  }
  return coefficients;
}

/** Inverts a square matrix over GF(2^8) by Gauss-Jordan with an identity augmentation. */
function invertMatrix(matrix: readonly number[][]): number[][] {
  const size = matrix.length;
  const work = matrix.map((row, rowIndex) => {
    const augmented: number[] = [
      ...row,
      ...Array.from({ length: size }, () => 0),
    ];
    augmented[size + rowIndex] = 1;
    return augmented;
  });
  for (let column = 0; column < size; column += 1) {
    let pivotRow = -1;
    for (let candidate = column; candidate < size; candidate += 1) {
      if ((work[candidate]?.[column] ?? 0) !== 0) {
        pivotRow = candidate;
        break;
      }
    }
    if (pivotRow === -1) {
      throw new Error("matrix is singular over GF(2^8)");
    }
    if (pivotRow !== column) {
      const swap = work[column] ?? [];
      work[column] = work[pivotRow] ?? [];
      work[pivotRow] = swap;
    }
    const pivotRowValues = work[column];
    if (pivotRowValues === undefined) {
      throw new Error("internal: pivot row vanished");
    }
    const pivotInverse = gfInv(pivotRowValues[column] ?? 1);
    for (let c = 0; c < 2 * size; c += 1) {
      pivotRowValues[c] = gfMul(pivotRowValues[c] ?? 0, pivotInverse);
    }
    for (let other = 0; other < size; other += 1) {
      if (other === column) continue;
      const factor = work[other]?.[column] ?? 0;
      if (factor === 0) continue;
      const target = work[other];
      const source = work[column];
      if (target === undefined || source === undefined) {
        throw new Error("internal: row vanished mid-inversion");
      }
      for (let c = 0; c < 2 * size; c += 1) {
        target[c] = (target[c] ?? 0) ^ gfMul(factor, source[c] ?? 0);
      }
    }
  }
  return work.map((row) => row.slice(size));
}

export async function encodeShards(
  data: Uint8Array,
  config: Readonly<ShardConfig>,
): Promise<Uint8Array<ArrayBuffer>[]> {
  validateConfig(config);
  const { dataShards, totalShards } = config;
  const shardLength = Math.ceil(data.length / dataShards);
  const shards: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < totalShards; i += 1) {
    shards.push(new Uint8Array(new ArrayBuffer(shardLength)));
  }
  for (let i = 0; i < dataShards; i += 1) {
    shards[i]?.set(data.subarray(i * shardLength, (i + 1) * shardLength));
    // The zero-fill of a fresh Uint8Array IS the padding: the last run simply keeps its trailing zeros per the pinned construction.
  }
  for (
    let parityIndex = dataShards;
    parityIndex < totalShards;
    parityIndex += 1
  ) {
    const coefficients = encodeMatrixRow(parityIndex, dataShards);
    for (let position = 0; position < shardLength; position += 1) {
      let accumulated = 0;
      for (let column = 0; column < dataShards; column += 1) {
        accumulated ^= gfMul(
          coefficients[column] ?? 0,
          shards[column]?.[position] ?? 0,
        );
      }
      const parityTarget = shards[parityIndex];
      if (parityTarget !== undefined) {
        parityTarget[position] = accumulated;
      }
    }
  }
  return Promise.resolve(shards);
}

/**
 * Reconstructs the original bytes from any dataShards of the totalShards
 * produced by encodeShards. originalLength is the manifest's own fact, not
 * derivable from the shards (zero-padding is indistinguishable from a
 * legitimate trailing zero byte), so the caller passes it -- #34's design
 * puts the length in the shard manifest alongside the device/transfer-id list.
 */
/** One surviving shard as presented for reconstruction: its ORIGINAL position among the encode output (the parity equation's row index), never its position in whichever array the caller collected survivors into -- confusing the two silently reconstructs garbage, which is exactly why the index is explicit rather than implied by array order. */
export interface PresentedShard {
  index: number;
  data: Uint8Array;
}

export async function decodeShards(
  presented: readonly PresentedShard[],
  config: Readonly<ShardConfig>,
  originalLength: number,
): Promise<Uint8Array<ArrayBuffer>> {
  validateConfig(config);
  const { dataShards, totalShards } = config;
  for (const entry of presented) {
    if (entry.index < 0 || entry.index >= totalShards) {
      throw new Error(
        `shard index ${String(entry.index)} is outside 0..${String(totalShards - 1)}`,
      );
    }
  }
  if (presented.length < dataShards) {
    throw new Error(
      `need at least ${String(dataShards)} shards to reconstruct, got ${String(presented.length)}`,
    );
  }
  const chosen = presented.slice(0, dataShards);
  const firstChosen = chosen[0];
  if (firstChosen === undefined) {
    throw new Error("internal: chosen shard set is empty");
  }
  const shardLength = firstChosen.data.length;

  // Recover the data shards' full byte content (not just the original prefix): the systematic rows let the all-data case pass through, any other mix goes through the inverted submatrix.
  const recovered: Uint8Array[] = [];
  if (chosen.every((entry) => entry.index < dataShards)) {
    // All data shards survived: identity passthrough, in DATA-shard order
    // (the caller's array order is arbitrary).
    for (let dataIndex = 0; dataIndex < dataShards; dataIndex += 1) {
      const entry = chosen.find((candidate) => candidate.index === dataIndex);
      if (entry === undefined) {
        throw new Error(
          "internal: data shard missing after the all-present check",
        );
      }
      recovered.push(entry.data);
    }
  } else {
    const submatrix: number[][] = chosen.map((entry) =>
      encodeMatrixRow(entry.index, dataShards),
    );
    const inverse = invertMatrix(submatrix);
    for (let dataIndex = 0; dataIndex < dataShards; dataIndex += 1) {
      const row = new Uint8Array(shardLength);
      for (let chosenIndex = 0; chosenIndex < dataShards; chosenIndex += 1) {
        const coefficient = inverse[dataIndex]?.[chosenIndex] ?? 0;
        if (coefficient === 0) continue;
        for (let position = 0; position < shardLength; position += 1) {
          row[position] =
            (row[position] ?? 0) ^
            gfMul(coefficient, chosen[chosenIndex]?.data[position] ?? 0);
        }
      }
      recovered.push(row);
    }
  }

  const totalLength = dataShards * shardLength;
  if (originalLength > totalLength) {
    throw new Error(
      `originalLength ${String(originalLength)} exceeds the shards' capacity ${String(totalLength)} -- wrong manifest for these shards`,
    );
  }
  const stitched = new Uint8Array(new ArrayBuffer(originalLength));
  for (let position = 0; position < originalLength; position += 1) {
    const shardIndex = Math.floor(position / shardLength);
    const within = position % shardLength;
    const byte = recovered[shardIndex]?.[within];
    if (byte === undefined) {
      throw new Error("shard position out of range while stitching");
    }
    stitched[position] = byte;
  }
  return Promise.resolve(stitched);
}
