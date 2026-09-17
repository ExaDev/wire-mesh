//! The two-round FROST signing protocol itself -- `threshold-commit`
//! (round 1: nonce generation and commitment) and `threshold-sign` (round
//! 2: signature-share release), plus coordinator-side aggregation.
//!
//! Nonce reuse across two released signature shares is catastrophic: it
//! discloses the participant's long-term share outright, and `T` such
//! disclosures reconstruct the group secret. [`round1_commit`] persists the
//! generated nonce pair via [`crate::nonce_store::NonceStore`] before
//! returning it to the caller, and [`round2_sign`] takes the nonce
//! exclusively via [`crate::nonce_store::NonceStore::take`] (one-shot,
//! never re-readable) rather than accepting it as a bare parameter a caller
//! could accidentally reuse.

use std::collections::BTreeMap;

use frost_ed25519::keys::{KeyPackage, PublicKeyPackage};
use frost_ed25519::round1::SigningCommitments;
use frost_ed25519::round2::SignatureShare;
use frost_ed25519::{Identifier, Signature, SigningPackage};
use rand::rngs::OsRng;

use crate::nonce_store::{NonceStore, NonceStoreError, SessionId};

/// An error in the signing flow.
#[derive(Debug)]
pub enum SigningError {
    Frost(frost_ed25519::Error),
    NonceStore(NonceStoreError),
}

impl core::fmt::Display for SigningError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SigningError::Frost(e) => write!(f, "FROST signing error: {e}"),
            SigningError::NonceStore(e) => write!(f, "nonce store error: {e}"),
        }
    }
}

impl std::error::Error for SigningError {}

impl From<frost_ed25519::Error> for SigningError {
    fn from(e: frost_ed25519::Error) -> Self {
        SigningError::Frost(e)
    }
}

impl From<NonceStoreError> for SigningError {
    fn from(e: NonceStoreError) -> Self {
        SigningError::NonceStore(e)
    }
}

/// Round 1: generates this participant's hiding/binding nonce pair and
/// commitments for `session_id`, durably persisting the nonce pair via
/// `store` BEFORE returning -- `spec/threshold.cddl`'s own verifier
/// obligation, enforced structurally here rather than left to caller
/// discipline. Returning the commitments IS this participant's act of
/// authorisation, per `threshold-subject`'s own comment: callers MUST have
/// already run their own content policy against the subject (see
/// `crate::subject`) before calling this.
pub fn round1_commit(
    store: &dyn NonceStore,
    session_id: SessionId,
    key_package: &KeyPackage,
) -> Result<SigningCommitments, SigningError> {
    let (nonces, commitments) =
        frost_ed25519::round1::commit(key_package.signing_share(), &mut OsRng);
    store.persist(session_id, nonces)?;
    Ok(commitments)
}

/// Round 2: takes (one-shot) the nonce pair persisted for `session_id` and
/// releases this participant's signature share over `message` -- the exact
/// bytes [`crate::subject::to_be_signed`] computed from this participant's
/// own stored round-1 state, never a `subject` carried on `threshold-sign`
/// itself (there is none: round 2 deliberately omits `subject`, so a
/// coordinator cannot show different participants different content across
/// the two rounds). A second call for the same `session_id` fails with
/// [`NonceStoreError::NotFound`] via `store.take`'s own one-shot contract --
/// the structural closure that makes "release two shares from one nonce
/// pair" unrepresentable, not merely discouraged.
pub fn round2_sign(
    store: &dyn NonceStore,
    session_id: SessionId,
    signing_package: &SigningPackage,
    key_package: &KeyPackage,
) -> Result<SignatureShare, SigningError> {
    let nonces = store.take(session_id)?;
    let share = frost_ed25519::round2::sign(signing_package, &nonces, key_package)?;
    Ok(share)
}

/// Coordinator-side: builds the `SigningPackage` round 2 is computed
/// against, from the commitments collected in round 1 and the message
/// every participant is expected to have independently reconstructed.
pub fn build_signing_package(
    commitments: BTreeMap<Identifier, SigningCommitments>,
    message: &[u8],
) -> SigningPackage {
    SigningPackage::new(commitments, message)
}

/// Coordinator-side: sums the collected signature shares into the final
/// aggregate signature and verifies it against the group's own public key
/// BEFORE returning it -- `frost_ed25519::aggregate` does both verification
/// steps the design calls for: the aggregate is checked against the group
/// key first (the common, cheap case), and only on failure does it fall
/// back to per-share verification (the `cheater-detection` feature, on by
/// default) to identify which specific participant supplied an invalid
/// share. A caller MUST treat any `Err` here as "publish nothing" -- FROST
/// aggregation cannot itself detect a malformed share; this verification
/// step is what turns "the signature is wrong" into a detectable,
/// attributable event before anything is published.
pub fn aggregate(
    signing_package: &SigningPackage,
    shares: &BTreeMap<Identifier, SignatureShare>,
    public_key_package: &PublicKeyPackage,
) -> Result<Signature, SigningError> {
    frost_ed25519::aggregate(signing_package, shares, public_key_package)
        .map_err(SigningError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dkg::{round1 as dkg_round1, round2 as dkg_round2, round3 as dkg_round3};
    use crate::identifiers::identifier_for_device;
    use crate::nonce_store::InMemoryNonceStore;
    use crate::subject::{to_be_signed, ThresholdSubject};
    use std::collections::BTreeMap as Map;
    use wire_mesh_wire::identity::DeviceId;

    /// Runs a fresh 3-participant DKG (T=2) purely as test fixture setup.
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

    #[test]
    fn two_of_three_participants_produce_a_signature_verifying_key_accepts() {
        let (ids, key_packages, public_key_package) = dkg_fixture();
        let signers = &ids[0..2]; // T=2
        let session_id = 1;

        let subject = ThresholdSubject {
            kind: "capability-token".to_owned(),
            protected: vec![0xa1, 0x01, 0x27],
            payload: vec![0xa1, 0x00, 0x01],
        };
        let message = to_be_signed(&subject);

        // Each signer is a separate device with its own nonce store.
        let mut stores = Map::new();
        let mut commitments = Map::new();
        for &id in signers {
            let store = InMemoryNonceStore::new();
            let kp = key_packages.get(&id).expect("key package");
            let c = round1_commit(&store, session_id, kp).expect("round1_commit");
            commitments.insert(id, c);
            stores.insert(id, store);
        }

        // The coordinator builds ONE shared SigningPackage from every signer's round-1 commitment and the message; every signer's round 2 is computed against this exact same package.
        let signing_package = build_signing_package(commitments, &message);

        let mut shares = Map::new();
        for &id in signers {
            let kp = key_packages.get(&id).expect("key package");
            let store = stores.get(&id).expect("store");
            let share = round2_sign(store, session_id, &signing_package, kp).expect("round2_sign");
            shares.insert(id, share);
        }

        let signature =
            aggregate(&signing_package, &shares, &public_key_package).expect("aggregate");
        assert!(public_key_package
            .verifying_key()
            .verify(&message, &signature)
            .is_ok());
    }

    #[test]
    fn a_forged_share_from_a_non_participant_key_fails_aggregation() {
        let (ids, key_packages, public_key_package) = dkg_fixture();
        let signers = &ids[0..2];
        let subject = ThresholdSubject {
            kind: "capability-token".to_owned(),
            protected: vec![0xa1, 0x01, 0x27],
            payload: vec![0xa1, 0x00, 0x01],
        };
        let message = to_be_signed(&subject);

        let mut commitments = Map::new();
        let mut stores = Map::new();
        for &id in signers {
            let store = InMemoryNonceStore::new();
            let kp = key_packages.get(&id).expect("key package");
            let c = round1_commit(&store, 1, kp).expect("round1_commit");
            commitments.insert(id, c);
            stores.insert(id, store);
        }
        let signing_package = build_signing_package(commitments, &message);

        // Both signers release real shares...
        let mut shares = Map::new();
        for &id in signers {
            let kp = key_packages.get(&id).expect("key package");
            let store = stores.get(&id).expect("store");
            let share = round2_sign(store, 1, &signing_package, kp).expect("round2_sign");
            shares.insert(id, share);
        }

        // ...but swap one signer's share for the OTHER signer's, simulating
        // a corrupted/forged share -- aggregation must reject it rather
        // than silently publish an invalid signature.
        let (&a, &b) = (
            signers.first().expect("2 signers"),
            signers.get(1).expect("2 signers"),
        );
        let share_a = shares.get(&a).cloned().expect("share a");
        shares.insert(b, share_a);

        let result = aggregate(&signing_package, &shares, &public_key_package);
        assert!(
            result.is_err(),
            "aggregation must reject a mismatched/forged share"
        );
    }
}
