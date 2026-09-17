//! A Lagrange-coefficient-at-zero over FROST(Ed25519, SHA-512) identifiers,
//! needed only by `reshare.rs`'s Lagrange-weighted-resharing construction
//! (see that module's own doc comment for why resharing to a changed
//! participant set needs it at all).
//!
//! `frost-core` implements the identical formula internally
//! (`compute_lagrange_coefficient`), but gates it behind its own
//! explicitly-unstable `internals` Cargo feature, not meant for external
//! stable consumption. Rather than build against that unstable surface,
//! this mirrors the published formula verbatim -- RFC 9591's own
//! `derive_interpolating_value` -- against `curve25519-dalek`'s public,
//! audited `Scalar` operators (`+`, `-`, `*`, `invert()`), operating only on
//! PUBLIC participant-identifier values, never secret data. This is
//! composition of existing audited primitives per a textbook formula, not a
//! reimplementation of curve or field arithmetic.

use curve25519_dalek::scalar::Scalar;
use frost_ed25519::Identifier;

/// An error computing a Lagrange coefficient.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LagrangeError {
    /// The identifier set was empty -- there is no coefficient to compute.
    EmptyIdentifierSet,
    /// `x_i` was not a member of `x_set` -- a caller asked for the
    /// coefficient of a participant that was not actually one of the
    /// interpolation points.
    NotAMember,
    /// Two members of `x_set` collided to the same scalar, or otherwise
    /// produced a zero denominator -- structurally impossible for distinct
    /// well-formed identifiers, surfaced as a typed error rather than a
    /// panic since this runs against peer-supplied identifier lists.
    DuplicatedIdentifier,
}

impl core::fmt::Display for LagrangeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            LagrangeError::EmptyIdentifierSet => write!(f, "empty identifier set"),
            LagrangeError::NotAMember => {
                write!(f, "identifier is not a member of the interpolation set")
            }
            LagrangeError::DuplicatedIdentifier => {
                write!(f, "duplicated identifier (zero denominator)")
            }
        }
    }
}

impl std::error::Error for LagrangeError {}

/// Decodes a FROST `Identifier`'s own canonical serialization into a raw
/// `curve25519-dalek` scalar. `Identifier::serialize()` and
/// `Scalar::from_canonical_bytes` use the identical little-endian encoding
/// (frost-ed25519's own `Ed25519ScalarField::deserialize` is implemented
/// against this exact `curve25519_dalek::Scalar::from_canonical_bytes` call,
/// confirmed against its source).
fn identifier_scalar(id: Identifier) -> Scalar {
    let bytes: [u8; 32] = id
        .serialize()
        .try_into()
        .unwrap_or_else(|_| unreachable!("Identifier::serialize() is always 32 bytes"));
    Option::from(Scalar::from_canonical_bytes(bytes))
        .unwrap_or_else(|| unreachable!("a valid Identifier's bytes are always a canonical scalar"))
}

/// The Lagrange basis polynomial ℓ_i(0) for participant `x_i` within the
/// interpolation set `x_set` -- i.e. the weight by which `x_i`'s own share
/// contributes to reconstructing the secret at x=0. Mirrors
/// `frost_core::compute_lagrange_coefficient(x_set, x=None, x_i)` exactly.
pub fn lagrange_coefficient_at_zero(
    x_set: &[Identifier],
    x_i: Identifier,
) -> Result<Scalar, LagrangeError> {
    if x_set.is_empty() {
        return Err(LagrangeError::EmptyIdentifierSet);
    }

    let mut num = Scalar::ONE;
    let mut den = Scalar::ONE;
    let mut x_i_found = false;
    let x_i_scalar = identifier_scalar(x_i);

    for &x_j in x_set {
        if x_j == x_i {
            x_i_found = true;
            continue;
        }
        let x_j_scalar = identifier_scalar(x_j);
        // x=0 case of the general ℓ_i(x) formula: signs on both num/den are
        // inverted relative to the general form purely to avoid a Neg bound
        // on Scalar, matching frost-core's own derivation exactly.
        num *= x_j_scalar;
        den *= x_j_scalar - x_i_scalar;
    }

    if !x_i_found {
        return Err(LagrangeError::NotAMember);
    }

    let den_inv: Scalar = Option::from(den.invert()).ok_or(LagrangeError::DuplicatedIdentifier)?;
    Ok(num * den_inv)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u16) -> Identifier {
        Identifier::try_from(n).expect("nonzero u16 is a valid identifier")
    }

    #[test]
    fn coefficients_over_a_set_sum_a_known_polynomial_back_to_its_constant_term() {
        // f(x) = 5 + 3x, evaluated at x=1,2,3 (t=2 threshold, so any 2 of
        // the 3 points reconstruct f(0) = 5 via Lagrange interpolation).
        let f = |x: u64| 5u64 + 3 * x;
        let ids = [id(1), id(2)];
        let mut reconstructed = Scalar::ZERO;
        for &i in &ids {
            let coeff = lagrange_coefficient_at_zero(&ids, i).expect("computes");
            let x = match i {
                v if v == id(1) => 1u64,
                v if v == id(2) => 2u64,
                _ => unreachable!(),
            };
            reconstructed += coeff * Scalar::from(f(x));
        }
        assert_eq!(reconstructed, Scalar::from(5u64));
    }

    #[test]
    fn different_two_point_subsets_reconstruct_the_same_constant_term() {
        let f = |x: u64| 5u64 + 3 * x;
        let subsets: [[Identifier; 2]; 3] = [[id(1), id(2)], [id(1), id(3)], [id(2), id(3)]];
        for subset in subsets {
            let mut reconstructed = Scalar::ZERO;
            for &i in &subset {
                let coeff = lagrange_coefficient_at_zero(&subset, i).expect("computes");
                let x = match i {
                    v if v == id(1) => 1u64,
                    v if v == id(2) => 2u64,
                    v if v == id(3) => 3u64,
                    _ => unreachable!(),
                };
                reconstructed += coeff * Scalar::from(f(x));
            }
            assert_eq!(reconstructed, Scalar::from(5u64));
        }
    }

    #[test]
    fn rejects_a_non_member_identifier() {
        let ids = [id(1), id(2)];
        let err = lagrange_coefficient_at_zero(&ids, id(3)).unwrap_err();
        assert_eq!(err, LagrangeError::NotAMember);
    }

    #[test]
    fn rejects_an_empty_set() {
        let err = lagrange_coefficient_at_zero(&[], id(1)).unwrap_err();
        assert_eq!(err, LagrangeError::EmptyIdentifierSet);
    }
}
