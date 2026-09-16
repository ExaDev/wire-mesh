//! K-of-N erasure coding over GF(2^8) for wire-mesh#36's mailbox-opacity
//! case (the shard half of #34's encrypt-then-shard design) -- the Rust
//! half of the byte-identical pair with
//! `ts/packages/core/src/domain/erasure-coding.ts`. A systematic
//! construction: the first `data_shards` shards ARE the zero-padded input
//! split into equal runs, and the remaining shards are Cauchy parity rows
//! `c_i = 1/(x_j XOR y_i)` with `x_j = row`, `y_i = column`. Cauchy, not
//! Vandermonde, because only Cauchy guarantees EVERY square submatrix is
//! invertible -- identity-plus-Vandermonde has singular K-subsets. Any
//! `data_shards` of `total_shards` reconstruct the input; a single mailbox
//! holder has one shard and never the epoch key either.
//!
//! The pinned cross-language vector (asserted identically in both suites):
//! K=2 N=3 over "wire-mesh" produces shards "wire-", "mesh\0", and the
//! parity bytes `[101, 153, 227, 111, 152]`.

/// The AES field's irreducible polynomial x^8+x^4+x^3+x+1, the conventional GF(2^8) choice.
const GF_POLY: u16 = 0x11d;
/// The bit that appears when a GF(2^8) value overflows a byte and needs the polynomial reduction.
const GF_OVERFLOW_BIT: u16 = 0x100;
/// GF(2^8) caps total shards at 255 (a 256th row would repeat, breaking invertibility).
const GF_MAX_SHARDS: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShardConfig {
    pub data_shards: usize,
    pub total_shards: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErasureError {
    /// data_shards < 1, total_shards < data_shards, or shards beyond the field.
    InvalidConfig(String),
    /// Fewer than data_shards surviving shards were presented.
    TooFewShards { have: usize, need: usize },
    /// A presented shard index is outside 0..total_shards.
    IndexOutOfRange { index: usize },
    /// The manifest's original length exceeds the shards' padded capacity.
    LengthExceedsCapacity { length: usize, capacity: usize },
}

impl core::fmt::Display for ErasureError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ErasureError::InvalidConfig(what) => write!(f, "invalid shard config: {what}"),
            ErasureError::TooFewShards { have, need } => {
                write!(f, "need at least {need} shards to reconstruct, got {have}")
            }
            ErasureError::IndexOutOfRange { index } => {
                write!(f, "shard index {index} is outside the configured range")
            }
            ErasureError::LengthExceedsCapacity { length, capacity } => write!(
                f,
                "original length {length} exceeds the shards' capacity {capacity} -- wrong manifest for these shards"
            ),
        }
    }
}

impl std::error::Error for ErasureError {}

/// Exponent and log tables over the field, built once at first use.
struct Tables {
    exp: Vec<u8>,
    log: Vec<u8>,
}

fn tables() -> &'static Tables {
    use std::sync::OnceLock;
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut exp = vec![0u8; 2 * GF_MAX_SHARDS];
        let mut log = vec![0u8; GF_MAX_SHARDS + 1];
        let mut x: u16 = 1;
        for (power, slot) in exp.iter_mut().enumerate().take(GF_MAX_SHARDS) {
            *slot = x as u8;
            log[x as usize] = power as u8;
            x <<= 1;
            if x & GF_OVERFLOW_BIT != 0 {
                x ^= GF_POLY;
            }
        }
        // The second half lets exp[a+b] index past 255 without a modulo.
        for power in GF_MAX_SHARDS..2 * GF_MAX_SHARDS {
            exp[power] = exp[power - GF_MAX_SHARDS];
        }
        Tables { exp, log }
    })
}

fn gf_mul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        return 0;
    }
    let t = tables();
    t.exp[(t.log[a as usize] as usize) + (t.log[b as usize] as usize)]
}

fn gf_inv(a: u8) -> u8 {
    let t = tables();
    t.exp[GF_MAX_SHARDS - t.log[a as usize] as usize]
}

fn validate_config(config: ShardConfig) -> Result<(), ErasureError> {
    let ShardConfig {
        data_shards,
        total_shards,
    } = config;
    if data_shards < 1 {
        return Err(ErasureError::InvalidConfig(format!(
            "data_shards must be at least 1, got {data_shards}"
        )));
    }
    if total_shards < data_shards {
        return Err(ErasureError::InvalidConfig(format!(
            "total_shards must be at least data_shards ({data_shards}), got {total_shards}"
        )));
    }
    if total_shards > GF_MAX_SHARDS {
        return Err(ErasureError::InvalidConfig(format!(
            "the GF(2^8) field supports at most {GF_MAX_SHARDS} shards, got {total_shards}"
        )));
    }
    Ok(())
}

/// Row `row` of the encode matrix: identity rows for the data shards,
/// Cauchy rows for parity (see the module doc for the guarantee).
fn encode_matrix_row(row: usize, data_shards: usize) -> Vec<u8> {
    let mut coefficients = vec![0u8; data_shards];
    if row < data_shards {
        coefficients[row] = 1;
        return coefficients;
    }
    for (column, slot) in coefficients.iter_mut().enumerate() {
        *slot = gf_inv((row ^ column) as u8);
    }
    coefficients
}

/// Inverts a square matrix over GF(2^8) by Gauss-Jordan with an identity
/// augmentation. Errors (rather than panics) on a singular input -- for
/// the Cauchy construction that is unreachable, but this is generic math.
fn invert_matrix(matrix: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, ErasureError> {
    let size = matrix.len();
    let mut work: Vec<Vec<u8>> = matrix
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            let mut augmented = row.clone();
            augmented.resize(2 * size, 0);
            augmented[size + row_index] = 1;
            augmented
        })
        .collect();
    for column in 0..size {
        let pivot_row = (column..size).find(|candidate| work[*candidate][column] != 0);
        let pivot_row = match pivot_row {
            Some(found) => found,
            None => {
                return Err(ErasureError::InvalidConfig(
                    "matrix is singular over GF(2^8)".to_owned(),
                ))
            }
        };
        if pivot_row != column {
            work.swap(column, pivot_row);
        }
        let pivot_inverse = gf_inv(work[column][column]);
        for value in work[column].iter_mut() {
            *value = gf_mul(*value, pivot_inverse);
        }
        for other in 0..size {
            if other == column {
                continue;
            }
            let factor = work[other][column];
            if factor == 0 {
                continue;
            }
            let source = work[column].clone();
            let target = &mut work[other];
            for (target_slot, source_slot) in target.iter_mut().zip(source.iter()) {
                *target_slot ^= gf_mul(factor, *source_slot);
            }
        }
    }
    Ok(work.into_iter().map(|row| row[size..].to_vec()).collect())
}

/// Splits `data` into `total_shards` shards, any `data_shards` of which
/// reconstruct it: the first `data_shards` are the zero-padded input in
/// equal runs (systematic), the rest are Cauchy parity.
pub fn encode_shards(data: &[u8], config: ShardConfig) -> Result<Vec<Vec<u8>>, ErasureError> {
    validate_config(config)?;
    let ShardConfig {
        data_shards,
        total_shards,
    } = config;
    let shard_length = data.len().div_ceil(data_shards);
    let mut shards = vec![vec![0u8; shard_length]; total_shards];
    for (i, shard) in shards.iter_mut().enumerate().take(data_shards) {
        // The last run may be shorter than shard_length (the input is not a
        // multiple of K): copy what exists, and the zero-fill of a fresh
        // shard IS the padding for the rest.
        let start = i * shard_length;
        let end = ((i + 1) * shard_length).min(data.len());
        shard[..end - start].copy_from_slice(&data[start..end]);
    }
    for parity_index in data_shards..total_shards {
        let coefficients = encode_matrix_row(parity_index, data_shards);
        let parity_bytes: Vec<u8> = (0..shard_length)
            .map(|position| {
                let mut accumulated: u8 = 0;
                for (column, coefficient) in coefficients.iter().enumerate() {
                    accumulated ^= gf_mul(*coefficient, shards[column][position]);
                }
                accumulated
            })
            .collect();
        shards[parity_index] = parity_bytes;
    }
    Ok(shards)
}

/// One surviving shard as presented for reconstruction: its ORIGINAL
/// position among the encode output (the parity equation's row index),
/// never its position in whichever collection the caller gathered
/// survivors into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentedShard {
    pub index: usize,
    pub data: Vec<u8>,
}

/// Reconstructs the original bytes from any `data_shards` of the
/// `total_shards` produced by [`encode_shards`]. `original_length` is the
/// manifest's own fact -- zero-padding is indistinguishable from a
/// legitimate trailing zero byte, so the length is not derivable from the
/// shards themselves.
pub fn decode_shards(
    presented: &[PresentedShard],
    config: ShardConfig,
    original_length: usize,
) -> Result<Vec<u8>, ErasureError> {
    validate_config(config)?;
    let ShardConfig {
        data_shards,
        total_shards,
    } = config;
    for entry in presented {
        if entry.index >= total_shards {
            return Err(ErasureError::IndexOutOfRange { index: entry.index });
        }
    }
    if presented.len() < data_shards {
        return Err(ErasureError::TooFewShards {
            have: presented.len(),
            need: data_shards,
        });
    }
    let chosen = &presented[..data_shards];
    let shard_length = chosen[0].data.len();

    // Recover every data shard's full padded content. All-data-shards is an
    // identity passthrough (in DATA-shard order, not caller order); any
    // other mix goes through the inverted submatrix.
    let mut recovered: Vec<Vec<u8>> = Vec::with_capacity(data_shards);
    if chosen.iter().all(|entry| entry.index < data_shards) {
        for data_index in 0..data_shards {
            let entry = chosen
                .iter()
                .find(|candidate| candidate.index == data_index)
                .ok_or_else(|| {
                    ErasureError::InvalidConfig(
                        "internal: data shard missing after the all-present check".to_owned(),
                    )
                })?;
            recovered.push(entry.data.clone());
        }
    } else {
        let submatrix: Vec<Vec<u8>> = chosen
            .iter()
            .map(|entry| encode_matrix_row(entry.index, data_shards))
            .collect();
        let inverse = invert_matrix(&submatrix)?;
        for inverse_row in inverse.iter().take(data_shards) {
            let mut row = vec![0u8; shard_length];
            for (chosen_index, coefficient) in inverse_row.iter().enumerate() {
                if *coefficient == 0 {
                    continue;
                }
                let source = &chosen[chosen_index].data;
                for (position, slot) in row.iter_mut().enumerate() {
                    let contribution = gf_mul(*coefficient, source[position]);
                    *slot ^= contribution;
                }
            }
            recovered.push(row);
        }
    }

    let capacity = data_shards * shard_length;
    if original_length > capacity {
        return Err(ErasureError::LengthExceedsCapacity {
            length: original_length,
            capacity,
        });
    }
    let mut stitched = vec![0u8; original_length];
    for (position, out) in stitched.iter_mut().enumerate() {
        let shard_index = position / shard_length;
        let within = position % shard_length;
        *out = recovered[shard_index][within];
    }
    Ok(stitched)
}

#[cfg(test)]
mod tests {
    use super::*;

    const K2_N2: ShardConfig = ShardConfig {
        data_shards: 2,
        total_shards: 2,
    };
    const K2_N3: ShardConfig = ShardConfig {
        data_shards: 2,
        total_shards: 3,
    };
    const K2_N4: ShardConfig = ShardConfig {
        data_shards: 2,
        total_shards: 4,
    };
    const K2_N5: ShardConfig = ShardConfig {
        data_shards: 2,
        total_shards: 5,
    };
    const K3_N4: ShardConfig = ShardConfig {
        data_shards: 3,
        total_shards: 4,
    };
    const K3_N5: ShardConfig = ShardConfig {
        data_shards: 3,
        total_shards: 5,
    };

    fn text(value: &str) -> Vec<u8> {
        value.as_bytes().to_vec()
    }

    fn survivors_of(shards: &[Vec<u8>], dropped: &[usize]) -> Vec<PresentedShard> {
        shards
            .iter()
            .enumerate()
            .filter(|(index, _)| !dropped.contains(index))
            .map(|(index, data)| PresentedShard {
                index,
                data: data.clone(),
            })
            .collect()
    }

    #[test]
    fn reconstructs_from_every_k_subset() {
        let data = text("erasure-coded notice content");
        let shards = encode_shards(&data, K3_N5).expect("encode");
        assert_eq!(shards.len(), K3_N5.total_shards);
        for drop1 in 0..K3_N5.total_shards {
            for drop2 in (drop1 + 1)..K3_N5.total_shards {
                let decoded =
                    decode_shards(&survivors_of(&shards, &[drop1, drop2]), K3_N5, data.len())
                        .expect("decode");
                assert_eq!(decoded, data);
            }
        }
    }

    #[test]
    fn round_trips_k_equals_n_pure_splitting() {
        let data = text("split me");
        let shards = encode_shards(&data, K2_N2).expect("encode");
        assert_eq!(shards[0], text("spli"));
        assert_eq!(shards[1], text("t me"));
        let decoded =
            decode_shards(&survivors_of(&shards, &[]), K2_N2, data.len()).expect("decode");
        assert_eq!(decoded, data);
    }

    #[test]
    fn reconstructs_from_first_k_shards() {
        let data = text("data shards alone");
        let shards = encode_shards(&data, K3_N4).expect("encode");
        let only_parity_dropped = [K3_N4.data_shards];
        let decoded = decode_shards(
            &survivors_of(&shards, &only_parity_dropped),
            K3_N4,
            data.len(),
        )
        .expect("decode");
        assert_eq!(decoded, data);
    }

    #[test]
    fn reconstructs_with_zero_data_shards_parity_only() {
        let data = text("parity only");
        let shards = encode_shards(&data, K2_N5).expect("encode");
        let decoded =
            decode_shards(&survivors_of(&shards, &[0, 1]), K2_N5, data.len()).expect("decode");
        assert_eq!(decoded, data);
    }

    #[test]
    fn pads_the_last_shard_and_trims_to_original_length() {
        let data = text("abcde");
        let shards = encode_shards(&data, K3_N5).expect("encode");
        let decoded =
            decode_shards(&survivors_of(&shards, &[1, 2]), K3_N5, data.len()).expect("decode");
        assert_eq!(decoded, data);
        assert_eq!(decoded.len(), data.len());
    }

    #[test]
    fn rejects_fewer_than_k_shards() {
        let data = text("too few");
        let shards = encode_shards(&data, K3_N5).expect("encode");
        let result = decode_shards(&survivors_of(&shards, &[2, 3, 4]), K3_N5, data.len());
        assert!(matches!(
            result,
            Err(ErasureError::TooFewShards { have: 2, need: 3 })
        ));
    }

    #[test]
    fn rejects_impossible_configs() {
        let data = text("x");
        assert!(matches!(
            encode_shards(
                &data,
                ShardConfig {
                    data_shards: 3,
                    total_shards: 2
                }
            ),
            Err(ErasureError::InvalidConfig(_))
        ));
        assert!(matches!(
            encode_shards(
                &data,
                ShardConfig {
                    data_shards: 256,
                    total_shards: 257
                }
            ),
            Err(ErasureError::InvalidConfig(_))
        ));
    }

    #[test]
    fn rejects_shard_index_out_of_range() {
        let data = text("bounds");
        let shards = encode_shards(&data, K2_N3).expect("encode");
        let presented = vec![
            PresentedShard {
                index: 0,
                data: shards[0].clone(),
            },
            PresentedShard {
                index: 7,
                data: shards[1].clone(),
            },
        ];
        assert!(matches!(
            decode_shards(&presented, K2_N3, data.len()),
            Err(ErasureError::IndexOutOfRange { index: 7 })
        ));
    }

    #[test]
    fn empty_input_round_trips() {
        let shards = encode_shards(&[], K2_N3).expect("encode");
        let decoded = decode_shards(&survivors_of(&shards, &[1]), K2_N3, 0).expect("decode");
        assert!(decoded.is_empty());
    }

    #[test]
    fn handles_binary_input_including_zero_bytes() {
        let data = vec![0u8, 255, 0, 1, 0, 128, 0, 0, 7];
        let shards = encode_shards(&data, K2_N4).expect("encode");
        let drop_sets: [&[usize]; 8] = [&[0], &[1], &[2], &[3], &[0, 1], &[0, 2], &[1, 3], &[2, 3]];
        for dropped in drop_sets {
            let decoded =
                decode_shards(&survivors_of(&shards, dropped), K2_N4, data.len()).expect("decode");
            assert_eq!(decoded, data);
        }
    }

    /// The cross-language pin: byte-identical to the TypeScript suite's own
    /// assertion over the same input and configuration.
    #[test]
    fn produces_the_byte_pinned_cross_language_vector() {
        let data = text("wire-mesh");
        let shards = encode_shards(&data, K2_N3).expect("encode");
        assert_eq!(shards[0], text("wire-"));
        assert_eq!(shards[1], {
            let mut padded = text("mesh");
            padded.push(0);
            padded
        });
        assert_eq!(shards[2], vec![101, 153, 227, 111, 152]);
        let presented = vec![
            PresentedShard {
                index: 0,
                data: shards[0].clone(),
            },
            PresentedShard {
                index: 2,
                data: shards[2].clone(),
            },
        ];
        let round_trip = decode_shards(&presented, K2_N3, data.len()).expect("decode");
        assert_eq!(round_trip, data);
    }
}
