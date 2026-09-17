//! Durable nonce persistence -- a storage-boundary port, not a concrete
//! backend, per this project's own portable-storage-boundary conventions.
//! Nonce reuse across two released signature shares is catastrophic: it
//! discloses the participant's long-term key share outright, and `T` such
//! disclosures reconstruct the group secret (the FROST equivalent of the
//! ECDSA nonce-reuse failure class). `spec/threshold.cddl`'s own verifier
//! obligations require a participant to durably persist its round-1 nonce
//! pair BEFORE the round-1 response leaves the device, and to mark it used
//! atomically BEFORE the round-2 response leaves the device -- a crash
//! between rounds fails closed, the session aborts, and the nonce is
//! discarded, never re-derived or resumed from partial state. This trait is
//! the contract that obligation is checked against; concrete storage
//! (SQLite, a file, `wire-mesh-core`'s own `KeyValueStorage` port) lives in
//! an adapter, never here.

use std::collections::BTreeMap;
use std::sync::Mutex;

use frost_ed25519::round1::SigningNonces;

/// A single signing session's own correlation id, matching
/// `spec/threshold.cddl`'s `session-id: uint`.
pub type SessionId = u64;

/// An error persisting or retrieving nonce state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NonceStoreError {
    /// A caller asked to persist a nonce for a `session_id` that already has
    /// one on record -- reusing a `session_id` would silently make round 2
    /// ambiguous about which nonce pair to release, so this is refused
    /// outright rather than silently overwritten.
    AlreadyPersisted(SessionId),
    /// A caller asked to take (mark-used-and-return) a nonce for a
    /// `session_id` this store has no record of -- either it was never
    /// persisted, it already expired, or (the security-critical case) a
    /// share for this session was already released once. Callers MUST
    /// treat this identically in all three cases: refuse to sign, never
    /// re-derive or fabricate a substitute nonce.
    NotFound(SessionId),
}

impl core::fmt::Display for NonceStoreError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            NonceStoreError::AlreadyPersisted(id) => {
                write!(f, "session-id {id} already has a persisted nonce pair")
            }
            NonceStoreError::NotFound(id) => {
                write!(f, "no persisted, unused nonce pair for session-id {id}")
            }
        }
    }
}

impl std::error::Error for NonceStoreError {}

/// The nonce-persistence contract. A second implementation on entirely
/// different storage primitives (a filesystem, a KV store, a hardware
/// secure element) satisfies this exact contract with zero changes to the
/// contract or its callers, per this project's own portability bar.
pub trait NonceStore: Send + Sync {
    /// Durably persists `nonces` for `session_id`, keyed so that at most one
    /// nonce pair ever exists per session. MUST complete (the write MUST be
    /// durable on disk, not merely buffered) before the caller's own
    /// round-1 response is allowed to leave the device -- an obligation
    /// this trait cannot enforce structurally, only its caller can.
    fn persist(&self, session_id: SessionId, nonces: SigningNonces) -> Result<(), NonceStoreError>;

    /// Atomically retrieves and removes the nonce pair for `session_id`. A
    /// second call for the same `session_id` MUST fail with
    /// [`NonceStoreError::NotFound`] -- this is what makes "release a
    /// second share for one nonce pair" structurally unrepresentable rather
    /// than merely discouraged.
    fn take(&self, session_id: SessionId) -> Result<SigningNonces, NonceStoreError>;

    /// Discards an abandoned session's nonce without releasing a share --
    /// the `deadline` expiry path and the `threshold.abort` path both call
    /// this, never `take`, since neither actually produces a signature.
    fn discard(&self, session_id: SessionId) -> Result<(), NonceStoreError>;
}

/// An in-memory [`NonceStore`] for tests and single-process development
/// only -- it satisfies the trait's own atomicity contract (a `Mutex`
/// guards a single take-then-remove critical section) but not its
/// durability obligation (a process crash loses everything), so a real
/// deployment MUST supply a disk-backed adapter instead.
#[derive(Default)]
pub struct InMemoryNonceStore {
    nonces: Mutex<BTreeMap<SessionId, SigningNonces>>,
}

impl InMemoryNonceStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl NonceStore for InMemoryNonceStore {
    fn persist(&self, session_id: SessionId, nonces: SigningNonces) -> Result<(), NonceStoreError> {
        let mut guard = self.nonces.lock().unwrap_or_else(|e| e.into_inner());
        if guard.contains_key(&session_id) {
            return Err(NonceStoreError::AlreadyPersisted(session_id));
        }
        guard.insert(session_id, nonces);
        Ok(())
    }

    fn take(&self, session_id: SessionId) -> Result<SigningNonces, NonceStoreError> {
        let mut guard = self.nonces.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .remove(&session_id)
            .ok_or(NonceStoreError::NotFound(session_id))
    }

    fn discard(&self, session_id: SessionId) -> Result<(), NonceStoreError> {
        let mut guard = self.nonces.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(&session_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use frost_ed25519::keys::SigningShare;
    use rand::rngs::OsRng;

    fn nonces() -> SigningNonces {
        let share = SigningShare::deserialize(&[7u8; 32]).unwrap_or_else(|_| {
            // [7u8; 32] is already a valid canonical Ed25519 scalar; this
            // branch exists only so a future ciphersuite change fails loudly
            // instead of silently producing nonsense nonces.
            panic!("fixed test scalar failed to deserialize")
        });
        frost_ed25519::round1::commit(&share, &mut OsRng).0
    }

    #[test]
    fn take_is_one_shot_a_second_call_for_the_same_session_fails() {
        let store = InMemoryNonceStore::new();
        store.persist(1, nonces()).expect("persist");
        store.take(1).expect("first take succeeds");
        let second = store.take(1);
        assert_eq!(second.unwrap_err(), NonceStoreError::NotFound(1));
    }

    #[test]
    fn persist_refuses_to_overwrite_an_existing_session() {
        let store = InMemoryNonceStore::new();
        store.persist(1, nonces()).expect("first persist");
        let second = store.persist(1, nonces());
        assert_eq!(second.unwrap_err(), NonceStoreError::AlreadyPersisted(1));
    }

    #[test]
    fn discard_makes_a_later_take_fail_closed() {
        let store = InMemoryNonceStore::new();
        store.persist(1, nonces()).expect("persist");
        store.discard(1).expect("discard");
        let take = store.take(1);
        assert_eq!(take.unwrap_err(), NonceStoreError::NotFound(1));
    }

    #[test]
    fn discard_of_an_unknown_session_is_not_an_error() {
        let store = InMemoryNonceStore::new();
        store
            .discard(999)
            .expect("discarding an unknown/already-expired session is a no-op");
    }
}
