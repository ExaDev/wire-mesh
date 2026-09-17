//! Fresh distributed key generation (`existing-group-key` absent on
//! `threshold-keygen-round1`) -- Pedersen DKG with Feldman VSS, wrapping
//! `frost_ed25519::keys::dkg::part1/part2/part3` directly. No device ever
//! holds the full secret at any point; this is a genuine DKG, never
//! "generate then split".
//!
//! wire-mesh has only point-to-point connections, so Pedersen DKG's own
//! assumption of a broadcast channel does not hold: a dishonest participant
//! could equivocate, sending different round-1 commitments to different
//! peers. [`transcript_digest`] is the echo-broadcast confirmation this
//! forces -- every participant hashes the full ordered set of round-1
//! packages it received and compares digests with every other participant
//! before accepting the DKG's output; a mismatch means the ceremony must
//! abort outright, never be repaired in place.

use std::collections::BTreeMap;

use frost_ed25519::keys::dkg::{round1, round2};
use frost_ed25519::keys::{KeyPackage, PublicKeyPackage};
use frost_ed25519::{Identifier, VerifyingKey};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};

/// An error in the fresh-DKG flow. Wraps `frost_ed25519::Error` (itself
/// already a rich, typed enum covering malformed packages, failed proofs of
/// knowledge, and incorrect share counts) plus the echo-broadcast
/// consistency failure that is specific to wire-mesh's own point-to-point
/// topology, not something frost-core itself has any notion of.
#[derive(Debug)]
pub enum DkgError {
    Frost(frost_ed25519::Error),
    /// The echo-broadcast transcript digest or the derived group key this
    /// participant computed did not match what another participant
    /// reported -- the DKG must abort; it is never repaired in place.
    TranscriptMismatch,
}

impl core::fmt::Display for DkgError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            DkgError::Frost(e) => write!(f, "FROST DKG error: {e}"),
            DkgError::TranscriptMismatch => {
                write!(f, "DKG echo-broadcast transcript mismatch -- aborting")
            }
        }
    }
}

impl std::error::Error for DkgError {}

impl From<frost_ed25519::Error> for DkgError {
    fn from(e: frost_ed25519::Error) -> Self {
        DkgError::Frost(e)
    }
}

/// Round 1: samples this participant's own random degree-`(threshold-1)`
/// polynomial, commits to its coefficients (Feldman VSS), and produces a
/// Schnorr proof of knowledge of the constant term -- load-bearing, not
/// ceremonial: without it, a participant broadcasting last could choose its
/// commitment adaptively to bias the resulting group key (the rogue-key /
/// key-cancellation attack). Returns the secret package this participant
/// keeps (never transmitted) and the package broadcast to every other
/// participant, matching `threshold-keygen-round1`'s own `commitment` +
/// `proof-of-knowledge` fields.
pub fn round1(
    own_identifier: Identifier,
    max_signers: u16,
    min_signers: u16,
) -> Result<(round1::SecretPackage, round1::Package), DkgError> {
    frost_ed25519::keys::dkg::part1(own_identifier, max_signers, min_signers, OsRng)
        .map_err(DkgError::from)
}

/// Round 2: verifies every other participant's round-1 proof of knowledge,
/// then computes this participant's own pairwise, confidential sub-shares
/// for every other participant -- `threshold-keygen-round2`'s own `share`
/// field, one message per recipient. `round1_packages` MUST NOT include this
/// participant's own package.
pub fn round2(
    own_secret_package: round1::SecretPackage,
    round1_packages: &BTreeMap<Identifier, round1::Package>,
) -> Result<(round2::SecretPackage, BTreeMap<Identifier, round2::Package>), DkgError> {
    frost_ed25519::keys::dkg::part2(own_secret_package, round1_packages).map_err(DkgError::from)
}

/// Round 3 (local, no wire traffic): verifies every received round-2
/// package against its sender's round-1 commitment, sums them into this
/// participant's own long-term [`KeyPackage`], and computes the group's
/// [`PublicKeyPackage`] (whose `verifying_key` -- the group's own Ed25519
/// public key -- becomes `group-device-id = SHA-256(verifying_key)`,
/// exactly `identity.cddl`'s ordinary device-id rule applied to the group).
pub fn round3(
    own_secret_package: &round2::SecretPackage,
    round1_packages: &BTreeMap<Identifier, round1::Package>,
    round2_packages: &BTreeMap<Identifier, round2::Package>,
) -> Result<(KeyPackage, PublicKeyPackage), DkgError> {
    frost_ed25519::keys::dkg::part3(own_secret_package, round1_packages, round2_packages)
        .map_err(DkgError::from)
}

/// Splits a DKG round-1 `Package` into `threshold-keygen-round1`'s own wire
/// shape: the Feldman commitment as independently-serialized coefficients
/// (`commitment: [* bstr]`) and the Schnorr proof of knowledge as a
/// separate `bstr` (`proof-of-knowledge`) -- unlike `Package::serialize()`'s
/// single combined blob, frost-core's own internal format. The inverse of
/// [`combine_round1_package`].
pub fn split_round1_package(
    package: &round1::Package,
) -> Result<(Vec<Vec<u8>>, Vec<u8>), DkgError> {
    let commitment = package.commitment().serialize()?;
    let proof_of_knowledge = package.proof_of_knowledge().serialize()?;
    Ok((commitment, proof_of_knowledge))
}

/// Reconstructs a DKG round-1 `Package` from the two independently-
/// serialized wire fields `threshold-keygen-round1` carries. The inverse of
/// [`split_round1_package`].
pub fn combine_round1_package(
    commitment: &[Vec<u8>],
    proof_of_knowledge: &[u8],
) -> Result<round1::Package, DkgError> {
    let commitment =
        frost_ed25519::keys::VerifiableSecretSharingCommitment::deserialize(commitment)?;
    let proof_of_knowledge = frost_ed25519::Signature::deserialize(proof_of_knowledge)?;
    Ok(round1::Package::new(commitment, proof_of_knowledge))
}

/// The echo-broadcast transcript digest this participant sends on
/// `threshold-keygen-confirm`: `SHA-256` over the full ordered (by
/// identifier) set of EVERY round-1 package for the ceremony -- including
/// this participant's own -- each encoded as `serialize()`'s own canonical
/// bytes, followed by the derived group verifying key. `BTreeMap`'s own
/// iteration order is already sorted by key (`Identifier`'s `Ord` impl), so
/// this is deterministic across participants with no separate sort step.
///
/// Every participant MUST include the full N-package set, not just the
/// packages it received from others: two honest participants who both saw
/// the identical broadcast (the only case that should ever occur) then
/// necessarily compute byte-identical digests, so any two participants'
/// digests are directly comparable. A dishonest dealer that equivocated --
/// sent a different commitment to different peers -- makes at least one
/// pair of participants' full-set digests disagree, which is exactly the
/// signal `threshold-keygen-confirm` exists to surface before anyone treats
/// the DKG as complete.
pub fn transcript_digest(
    all_round1_packages: &BTreeMap<Identifier, round1::Package>,
    group_key: &VerifyingKey,
) -> Result<[u8; 32], DkgError> {
    let mut hasher = Sha256::new();
    for (id, package) in all_round1_packages {
        hasher.update(id.serialize());
        hasher.update(package.serialize().map_err(DkgError::from)?);
    }
    hasher.update(group_key.serialize().map_err(DkgError::from)?);
    Ok(hasher.finalize().into())
}

/// Verifies this participant's own computed transcript digest and derived
/// group key against what a peer reported on `threshold-keygen-confirm`. A
/// verifier obligation per `spec/threshold.cddl`: any mismatch aborts the
/// whole ceremony outright.
pub fn confirm_matches(
    own_digest: &[u8; 32],
    own_group_key: &VerifyingKey,
    peer_digest: &[u8],
    peer_group_key: &[u8],
) -> Result<(), DkgError> {
    let own_group_key_bytes = own_group_key.serialize().map_err(DkgError::from)?;
    if own_digest.as_slice() == peer_digest && own_group_key_bytes == peer_group_key {
        Ok(())
    } else {
        Err(DkgError::TranscriptMismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identifiers::identifier_for_device;
    use wire_mesh_wire::identity::DeviceId;

    /// A full 3-participant, T=2 fresh DKG round trip -- every participant
    /// ends up agreeing on the same group verifying key and the same
    /// echo-broadcast transcript digest, which is the property the whole
    /// confirm round exists to check.
    #[test]
    fn three_participants_dkg_to_the_same_group_key_and_transcript() {
        let device_ids = [
            DeviceId::from_bytes([1; 32]),
            DeviceId::from_bytes([2; 32]),
            DeviceId::from_bytes([3; 32]),
        ];
        let ids: Vec<Identifier> = device_ids
            .iter()
            .map(|d| identifier_for_device(d).expect("derives"))
            .collect();

        // Round 1: everyone commits.
        let mut secrets1 = BTreeMap::new();
        let mut packages1: BTreeMap<Identifier, round1::Package> = BTreeMap::new();
        for &id in &ids {
            let (secret, package) = round1(id, 3, 2).expect("round1");
            secrets1.insert(id, secret);
            packages1.insert(id, package);
        }

        // Round 2: everyone exchanges pairwise sub-shares.
        let mut round2_inbox: BTreeMap<Identifier, BTreeMap<Identifier, round2::Package>> =
            BTreeMap::new();
        let mut secrets2 = BTreeMap::new();
        for &id in &ids {
            let own_secret = secrets1.remove(&id).expect("own secret1");
            let others: BTreeMap<Identifier, round1::Package> = packages1
                .iter()
                .filter(|(&pid, _)| pid != id)
                .map(|(&pid, p)| (pid, p.clone()))
                .collect();
            let (secret2, outgoing) = round2(own_secret, &others).expect("round2");
            secrets2.insert(id, secret2);
            for (recipient, package) in outgoing {
                round2_inbox
                    .entry(recipient)
                    .or_default()
                    .insert(id, package);
            }
        }

        // Round 3 (local) + confirm. Every participant's own transcript
        // digest covers the SAME full N-package set (its own package
        // included), so all three digests must land byte-identical.
        let mut key_packages = BTreeMap::new();
        let mut group_keys = Vec::new();
        let mut digests = Vec::new();
        for &id in &ids {
            let secret2 = secrets2.get(&id).expect("own secret2");
            let others1: BTreeMap<Identifier, round1::Package> = packages1
                .iter()
                .filter(|(&pid, _)| pid != id)
                .map(|(&pid, p)| (pid, p.clone()))
                .collect();
            let inbox2 = round2_inbox.get(&id).expect("inbox");
            let (key_package, public_key_package) =
                round3(secret2, &others1, inbox2).expect("round3");

            let digest =
                transcript_digest(&packages1, public_key_package.verifying_key()).expect("digest");
            digests.push(digest);
            group_keys.push(
                public_key_package
                    .verifying_key()
                    .serialize()
                    .expect("serialize"),
            );
            key_packages.insert(id, key_package);
        }

        assert!(group_keys.windows(2).all(|w| w[0] == w[1]));
        assert!(digests.windows(2).all(|w| w[0] == w[1]));
        assert_eq!(key_packages.len(), 3);
    }

    /// An equivocating dealer -- one participant sending a tampered
    /// commitment to only some peers -- must produce a transcript-digest
    /// mismatch, the signal `threshold-keygen-confirm` exists to catch
    /// before anyone treats the ceremony as complete.
    #[test]
    fn a_tampered_round1_package_fails_confirm_matches() {
        let a = identifier_for_device(&DeviceId::from_bytes([10; 32])).expect("derives");
        let b = identifier_for_device(&DeviceId::from_bytes([11; 32])).expect("derives");
        let (_secret_a, package_a) = round1(a, 2, 2).expect("round1 a");
        let (_secret_b, package_b) = round1(b, 2, 2).expect("round1 b");

        let mut view_honest = BTreeMap::new();
        view_honest.insert(a, package_a.clone());
        view_honest.insert(b, package_b.clone());

        // A second, independently generated round-1 package for `a` stands in for a tampered/equivocated broadcast -- what `b` would compute as its own transcript if `a` had sent it something different.
        let (_secret_a2, tampered_package_a) = round1(a, 2, 2).expect("round1 a again");
        let mut view_tampered = BTreeMap::new();
        view_tampered.insert(a, tampered_package_a);
        view_tampered.insert(b, package_b);

        // An arbitrary but fixed group key placeholder -- transcript_digest hashes it verbatim, so its own specific value is irrelevant to this test; what matters is that the two PACKAGE views differ.
        let group_key = PublicKeyPackage::from_dkg_commitments(
            &view_honest
                .iter()
                .map(|(id, p)| (*id, p.commitment()))
                .collect(),
        )
        .expect("derive a placeholder group key from the honest view");

        let honest_digest =
            transcript_digest(&view_honest, group_key.verifying_key()).expect("digest");
        let tampered_digest =
            transcript_digest(&view_tampered, group_key.verifying_key()).expect("digest");
        assert_ne!(honest_digest, tampered_digest);
    }

    /// `threshold-keygen-round1`'s own wire shape carries the Feldman
    /// commitment as an array of independently-serialized coefficients
    /// (`commitment: [* bstr]`) and the Schnorr proof of knowledge as a
    /// separate `bstr`, unlike `round1::Package::serialize()`'s single
    /// combined blob -- split then combine must round-trip to the identical
    /// package a peer's own round2 verifies against.
    #[test]
    fn split_and_combine_round1_package_round_trips() {
        let a = identifier_for_device(&DeviceId::from_bytes([1; 32])).expect("derives");
        let (_secret, package) = round1(a, 2, 2).expect("round1");

        let (commitment, proof) = split_round1_package(&package).expect("split");
        assert!(!commitment.is_empty());
        let recombined = combine_round1_package(&commitment, &proof).expect("combine");
        assert_eq!(recombined, package);
    }

    #[test]
    fn combine_round1_package_rejects_malformed_bytes() {
        assert!(combine_round1_package(&[vec![0u8; 4]], &[0u8; 4]).is_err());
    }
}
