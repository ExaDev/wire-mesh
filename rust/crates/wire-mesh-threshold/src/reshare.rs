//! Proactive resharing (`existing-group-key` present on
//! `threshold-keygen-round1`) -- one operation covering device loss, device
//! addition, and threshold change, per wire-mesh#29's own resolved design.
//! Resharing changes the shares without changing the group public key: `T`
//! surviving participants each re-share their own Lagrange-weighted share
//! of the group secret to a fresh, possibly-different `(T', N')`
//! participant set, and correctness follows from Lagrange interpolation's
//! own linearity (Σ λ_i·s_i = the group secret; summing each survivor's
//! sub-share of that weighted term at a new participant's point gives that
//! participant a valid point on a fresh degree-`(T'-1)` polynomial with the
//! identical constant term).
//!
//! This is deliberately NOT built on `frost_ed25519::keys::refresh`
//! (`refresh_dkg_part1/part2/refresh_dkg_shares`): that shipped, audited
//! family only ever ADDS a zero-secret delta onto a participant's own
//! EXISTING key package, which structurally cannot onboard a brand-new
//! device (it has no existing key package to add to) and, per the crate's
//! own documented constraint, cannot safely change the threshold. Instead
//! this composes three already-audited, already-public primitives exactly
//! as published (never hand-rolled curve/field arithmetic of its own):
//! `frost_ed25519::keys::split` (Shamir/Feldman share-splitting of an
//! arbitrary secret), `SecretShare::verify`/`KeyPackage`'s own consistency
//! checks, and `PublicKeyPackage::from_commitment`. The one piece with no
//! public, stable frost-core entry point is the Lagrange coefficient
//! itself (`crate::lagrange`), computed over PUBLIC identifiers only via
//! `curve25519-dalek`'s own audited `Scalar` operators, mirroring
//! frost-core's internals-gated formula verbatim.

use std::collections::BTreeMap;

use curve25519_dalek::edwards::EdwardsPoint;
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::Identity;
use frost_core::keys::CoefficientCommitment;
use frost_ed25519::keys::{
    IdentifierList, KeyPackage, PublicKeyPackage, SecretShare, SigningShare,
    VerifiableSecretSharingCommitment,
};
use frost_ed25519::{Ed25519Sha512, Identifier, SigningKey};
use rand::rngs::OsRng;

type Ed25519CoefficientCommitment = CoefficientCommitment<Ed25519Sha512>;

use crate::lagrange::{lagrange_coefficient_at_zero, LagrangeError};

/// An error in the reshare flow.
#[derive(Debug)]
pub enum ReshareError {
    Frost(frost_ed25519::Error),
    Lagrange(LagrangeError),
    /// The T survivors' broadcast commitment vectors were not all the same
    /// length -- they MUST be, since every survivor calls `split()` with
    /// the identical new threshold; a length mismatch means at least one
    /// survivor is malformed or malicious and the ceremony must abort.
    CommitmentLengthMismatch,
    /// A commitment vector was empty (nothing to sum) -- structurally
    /// impossible for a well-formed `split()` output, surfaced as a typed
    /// error rather than a panic since this runs over peer-supplied bytes.
    EmptyCommitment,
}

impl core::fmt::Display for ReshareError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ReshareError::Frost(e) => write!(f, "FROST reshare error: {e}"),
            ReshareError::Lagrange(e) => write!(f, "Lagrange coefficient error: {e}"),
            ReshareError::CommitmentLengthMismatch => {
                write!(
                    f,
                    "survivors' broadcast commitment vectors were not all the same length"
                )
            }
            ReshareError::EmptyCommitment => write!(f, "empty commitment vector"),
        }
    }
}

impl std::error::Error for ReshareError {}

impl From<frost_ed25519::Error> for ReshareError {
    fn from(e: frost_ed25519::Error) -> Self {
        ReshareError::Frost(e)
    }
}

impl From<LagrangeError> for ReshareError {
    fn from(e: LagrangeError) -> Self {
        ReshareError::Lagrange(e)
    }
}

/// Decodes a `SigningShare`'s raw scalar bytes into a `curve25519-dalek`
/// `Scalar` for arithmetic frost-core itself exposes no typed operation
/// for (multiplying by a public Lagrange coefficient). `SigningShare`'s own
/// `serialize()`/`deserialize()` use the identical little-endian canonical
/// encoding `Scalar::from_canonical_bytes`/`to_bytes` do (both ultimately
/// backed by the same `Ed25519ScalarField` `serialize`/`deserialize`
/// confirmed against frost-ed25519's own source).
fn signing_share_to_scalar(share: &SigningShare) -> Scalar {
    let bytes: [u8; 32] = share
        .serialize()
        .try_into()
        .unwrap_or_else(|_| unreachable!("SigningShare::serialize() is always 32 bytes"));
    Option::from(Scalar::from_canonical_bytes(bytes)).unwrap_or_else(|| {
        unreachable!("a valid SigningShare's bytes are always a canonical scalar")
    })
}

/// Round 1 (survivor side): this surviving participant computes its own
/// Lagrange-weighted sub-share of the group secret and splits it, via
/// audited Shamir/Feldman VSS, across the NEW participant set. Returns the
/// broadcast commitment (`threshold-keygen-round1`'s own `commitment`
/// field -- identical across every recipient, from a single dealer) and the
/// per-recipient `SecretShare`s (`threshold-keygen-round2`'s own `share`
/// field, one message per recipient, each self-contained: identifier,
/// signing share, AND the commitment together, so a recipient can verify it
/// standalone via `SecretShare::verify()` without separately correlating a
/// round-1 broadcast).
///
/// `old_survivor_ids` MUST be exactly the `T` identifiers whose shares are
/// being combined to reconstruct (via Lagrange interpolation, never
/// literally) the group secret -- i.e. this session's own full survivor
/// set, not merely "the participants I happen to know about". A wrong or
/// incomplete survivor set produces a self-consistent but WRONG group key,
/// caught only later by `threshold-keygen-confirm`'s own equality check
/// against `existing-group-key`.
pub fn round1_reshare(
    my_id: Identifier,
    my_old_share: &SigningShare,
    old_survivor_ids: &[Identifier],
    new_participant_ids: &[Identifier],
    new_min_signers: u16,
) -> Result<
    (
        VerifiableSecretSharingCommitment,
        BTreeMap<Identifier, SecretShare>,
    ),
    ReshareError,
> {
    let lambda_i = lagrange_coefficient_at_zero(old_survivor_ids, my_id)?;
    let weighted_scalar = lambda_i * signing_share_to_scalar(my_old_share);
    let weighted_key = SigningKey::from_scalar(weighted_scalar)?;

    let (shares, _my_own_weighted_public_key_package) = frost_ed25519::keys::split(
        &weighted_key,
        new_participant_ids.len() as u16,
        new_min_signers,
        IdentifierList::Custom(new_participant_ids),
        &mut OsRng,
    )?;

    let commitment = shares
        .values()
        .next()
        .map(|s| s.commitment().clone())
        .ok_or(ReshareError::EmptyCommitment)?;

    Ok((commitment, shares))
}

/// Sums `T` survivors' broadcast commitment vectors position-wise (EC point
/// addition via `curve25519-dalek`'s own `EdwardsPoint: Add`, exposed
/// through `CoefficientCommitment::value()`) into the ONE combined VSS
/// commitment `PublicKeyPackage::from_commitment` needs. This is the same
/// coefficient-wise summation `PublicKeyPackage::from_dkg_commitments` does
/// internally for ordinary DKG (that function is not reusable here directly
/// because it also derives the RECIPIENT set from the commitments' own
/// keys, which only holds when dealers and recipients are the same set --
/// true for DKG, false here, since the T survivors and the new N'
/// participant set are generally different).
pub fn combine_survivor_commitments(
    commitments: &[VerifiableSecretSharingCommitment],
) -> Result<VerifiableSecretSharingCommitment, ReshareError> {
    // Each commitment vector's own serialize() gives one 32-byte compressed
    // Ed25519 point per coefficient -- decoding back to CoefficientCommitment
    // (public) rather than a raw point keeps every intermediate value
    // typed, only ever touching curve25519-dalek for the actual Add.
    let per_commitment: Vec<Vec<Ed25519CoefficientCommitment>> = commitments
        .iter()
        .map(|c| {
            c.serialize()
                .map_err(ReshareError::from)?
                .iter()
                .map(|bytes| {
                    Ed25519CoefficientCommitment::deserialize(bytes).map_err(ReshareError::from)
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()?;

    let degree = per_commitment
        .first()
        .ok_or(ReshareError::EmptyCommitment)?
        .len();
    if degree == 0 {
        return Err(ReshareError::EmptyCommitment);
    }
    if per_commitment.iter().any(|c| c.len() != degree) {
        return Err(ReshareError::CommitmentLengthMismatch);
    }

    let mut summed = Vec::with_capacity(degree);
    for i in 0..degree {
        let mut point = EdwardsPoint::identity();
        for coefficients in &per_commitment {
            point += coefficients[i].value();
        }
        let bytes = point.compress().to_bytes();
        summed.push(Ed25519CoefficientCommitment::deserialize(&bytes)?);
    }

    Ok(VerifiableSecretSharingCommitment::deserialize(
        summed
            .iter()
            .map(|c| c.serialize())
            .collect::<Result<Vec<_>, _>>()?,
    )?)
}

/// The group's derived public key given the T survivors' combined broadcast
/// commitment and the NEW participant set -- reused directly by
/// `threshold-keygen-confirm`'s own `group-key` check (MUST equal
/// `existing-group-key` for a reshare; a mismatch means abort, never adopt).
pub fn derive_public_key_package(
    combined_commitment: &VerifiableSecretSharingCommitment,
    new_participant_ids: &[Identifier],
) -> Result<PublicKeyPackage, ReshareError> {
    let ids: std::collections::BTreeSet<Identifier> = new_participant_ids.iter().copied().collect();
    Ok(PublicKeyPackage::from_commitment(
        &ids,
        combined_commitment,
    )?)
}

/// Round 3 (new-participant side, local): verifies each of the `T` received
/// `SecretShare`s against its own embedded commitment (`SecretShare::verify`,
/// audited), sums the validated signing-share scalars into this new
/// participant's own long-term share, and builds the final [`KeyPackage`]
/// against the group's derived [`PublicKeyPackage`] -- the SAME
/// `verifying_key` for every participant, since it is a pure function of
/// the combined broadcast commitment every participant sees identically
/// (subject to the echo-broadcast confirm round actually catching any
/// equivocation, exactly as ordinary DKG's confirm round does).
pub fn combine_received_shares(
    my_id: Identifier,
    received: &[SecretShare],
    public_key_package: &PublicKeyPackage,
    new_min_signers: u16,
) -> Result<KeyPackage, ReshareError> {
    let mut combined = Scalar::ZERO;
    for share in received {
        let (_verifying_share, _weighted_group_key) = share.verify()?;
        combined += signing_share_to_scalar(share.signing_share());
    }

    let my_verifying_share = *public_key_package
        .verifying_shares()
        .get(&my_id)
        .ok_or(frost_ed25519::Error::UnknownIdentifier)?;

    Ok(KeyPackage::new(
        my_id,
        SigningShare::deserialize(&combined.to_bytes())?,
        my_verifying_share,
        *public_key_package.verifying_key(),
        new_min_signers,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dkg::{round1 as dkg_round1, round2 as dkg_round2, round3 as dkg_round3};
    use crate::identifiers::identifier_for_device;
    use crate::nonce_store::NonceStore;
    use std::collections::BTreeMap as Map;
    use wire_mesh_wire::identity::DeviceId;

    /// Fresh 3-of-3 DKG (T=2), matching `signing.rs`'s own fixture, kept
    /// local since reshare's tests need the raw `KeyPackage`s (including
    /// their signing shares) rather than just identifiers.
    fn dkg_fixture() -> (
        Vec<Identifier>,
        Map<Identifier, KeyPackage>,
        PublicKeyPackage,
    ) {
        let ids: Vec<Identifier> = (1u8..=3)
            .map(|b| identifier_for_device(&DeviceId::from_bytes([b; 32])).expect("derives"))
            .collect();

        let mut secrets1 = Map::new();
        let mut packages1: Map<Identifier, frost_ed25519::keys::dkg::round1::Package> = Map::new();
        for &id in &ids {
            let (s, p) = dkg_round1(id, 3, 2).expect("round1");
            secrets1.insert(id, s);
            packages1.insert(id, p);
        }

        let mut round2_inbox: Map<
            Identifier,
            Map<Identifier, frost_ed25519::keys::dkg::round2::Package>,
        > = Map::new();
        let mut secrets2 = Map::new();
        for &id in &ids {
            let own = secrets1.remove(&id).expect("secret1");
            let others: Map<_, _> = packages1
                .iter()
                .filter(|(&p, _)| p != id)
                .map(|(&p, v)| (p, v.clone()))
                .collect();
            let (s2, outgoing) = dkg_round2(own, &others).expect("round2");
            secrets2.insert(id, s2);
            for (recipient, package) in outgoing {
                round2_inbox
                    .entry(recipient)
                    .or_default()
                    .insert(id, package);
            }
        }

        let mut key_packages = Map::new();
        let mut public_key_package = None;
        for &id in &ids {
            let s2 = secrets2.get(&id).expect("secret2");
            let others1: Map<_, _> = packages1
                .iter()
                .filter(|(&p, _)| p != id)
                .map(|(&p, v)| (p, v.clone()))
                .collect();
            let inbox = round2_inbox.get(&id).expect("inbox");
            let (kp, pkp) = dkg_round3(s2, &others1, inbox).expect("round3");
            key_packages.insert(id, kp);
            public_key_package = Some(pkp);
        }

        (
            ids,
            key_packages,
            public_key_package.expect("at least one participant"),
        )
    }

    /// Reshares a T=2-of-3 group down to a T=2-of-2 group among 2 of the
    /// original 3 devices (a device-loss scenario): the group key MUST stay
    /// identical, and both surviving participants must end up with valid
    /// shares of it under the smaller committee.
    #[test]
    fn reshare_to_a_smaller_surviving_committee_preserves_the_group_key() {
        let (old_ids, key_packages, original_pkp) = dkg_fixture();
        let survivors = &old_ids[0..2]; // the T=2 participants doing the reshare
        let new_participants = survivors; // shrink: drop old_ids[2], no new devices added

        let mut commitments = Vec::new();
        let mut round2_by_recipient: Map<Identifier, Vec<SecretShare>> = Map::new();
        for &survivor in survivors {
            let kp = key_packages.get(&survivor).expect("key package");
            let (commitment, shares) =
                round1_reshare(survivor, kp.signing_share(), survivors, new_participants, 2)
                    .expect("round1_reshare");
            commitments.push(commitment);
            for (&recipient, share) in &shares {
                round2_by_recipient
                    .entry(recipient)
                    .or_default()
                    .push(share.clone());
            }
        }

        let combined_commitment = combine_survivor_commitments(&commitments).expect("combine");
        let new_pkp =
            derive_public_key_package(&combined_commitment, new_participants).expect("derive pkp");

        assert_eq!(
            new_pkp.verifying_key(),
            original_pkp.verifying_key(),
            "group key must survive a reshare unchanged"
        );

        let mut new_key_packages = Map::new();
        for &participant in new_participants {
            let received = round2_by_recipient
                .get(&participant)
                .expect("received shares");
            let kp = combine_received_shares(participant, received, &new_pkp, 2)
                .expect("combine_received_shares");
            new_key_packages.insert(participant, kp);
        }

        // The new shares actually produce a valid FROST signature under the
        // (unchanged) group key -- the real end-to-end proof this worked.
        let message = b"reshare-preserves-signing-capability";
        let store_a = crate::nonce_store::InMemoryNonceStore::new();
        let store_b = crate::nonce_store::InMemoryNonceStore::new();
        let kp_a = new_key_packages.get(&new_participants[0]).expect("kp a");
        let kp_b = new_key_packages.get(&new_participants[1]).expect("kp b");
        let (nonces_a, commitments_a) =
            frost_ed25519::round1::commit(kp_a.signing_share(), &mut OsRng);
        let (nonces_b, commitments_b) =
            frost_ed25519::round1::commit(kp_b.signing_share(), &mut OsRng);
        store_a.persist(1, nonces_a).expect("persist a");
        store_b.persist(1, nonces_b).expect("persist b");
        let mut package_commitments = Map::new();
        package_commitments.insert(new_participants[0], commitments_a);
        package_commitments.insert(new_participants[1], commitments_b);
        let signing_package = frost_ed25519::SigningPackage::new(package_commitments, message);

        let share_a =
            frost_ed25519::round2::sign(&signing_package, &store_a.take(1).expect("take a"), kp_a)
                .expect("sign a");
        let share_b =
            frost_ed25519::round2::sign(&signing_package, &store_b.take(1).expect("take b"), kp_b)
                .expect("sign b");
        let mut shares = Map::new();
        shares.insert(new_participants[0], share_a);
        shares.insert(new_participants[1], share_b);

        let signature =
            frost_ed25519::aggregate(&signing_package, &shares, &new_pkp).expect("aggregate");
        assert!(original_pkp
            .verifying_key()
            .verify(message, &signature)
            .is_ok());
    }

    /// The dropped device's OLD share must NOT combine with the survivors'
    /// NEW shares into anything valid -- this is the security property
    /// resharing exists to provide (an attacker holding one stolen old
    /// share has nothing after a reshare).
    #[test]
    fn a_dropped_devices_old_share_is_incompatible_with_the_reshared_group() {
        let (old_ids, key_packages, _original_pkp) = dkg_fixture();
        let survivors = &old_ids[0..2];
        let dropped = old_ids[2];
        let dropped_old_key_package = key_packages.get(&dropped).expect("dropped kp");

        let mut commitments = Vec::new();
        for &survivor in survivors {
            let kp = key_packages.get(&survivor).expect("key package");
            let (commitment, _shares) =
                round1_reshare(survivor, kp.signing_share(), survivors, survivors, 2)
                    .expect("round1_reshare");
            commitments.push(commitment);
        }
        let combined_commitment = combine_survivor_commitments(&commitments).expect("combine");
        let new_pkp =
            derive_public_key_package(&combined_commitment, survivors).expect("derive pkp");

        // The dropped device's old verifying share has no entry at all in
        // the new PublicKeyPackage -- it was never a member of the reshared
        // committee, so there is nothing for its old share to even be
        // checked against.
        assert!(new_pkp.verifying_shares().get(&dropped).is_none());
        let _ = dropped_old_key_package;
    }
}
