//! `threshold-subject` -- what a signing session actually asks a group to
//! sign, and the single most important design decision in the whole
//! protocol: it carries the FULL decoded content, never a bare hash. A
//! participant that commits to an opaque digest is a blind signer, and the
//! entire security value of T-of-N is that each participant independently
//! reviews and authorises the content -- returning a round-1 commitment IS
//! that act of authorisation. This module builds exactly the bytes a
//! participant signs its round-1 commitment over: the RFC 9052 §4.4
//! `Sig_structure`, reusing `wire_mesh_core::domain::cose::sig_structure`
//! rather than a second hand-rolled construction, and NEVER accepting a
//! pre-assembled to-be-signed blob from a coordinator.

use wire_mesh_core::domain::cose::sig_structure;

/// The `kind` discriminator on `threshold-subject` -- an open `tstr` per
/// `spec/CONVENTIONS.md`'s own open-tstr-over-closed-enum convention, since
/// future content a group signs is not limited to what wire-mesh itself
/// already defines self-certifying payloads for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdSubject {
    pub kind: String,
    /// `bstr .cbor cose-token-headers` -- the protected header the
    /// aggregate signature will carry.
    pub protected: Vec<u8>,
    /// `bstr .cbor` of the claims structure `kind` names.
    pub payload: Vec<u8>,
}

/// The kinds this participant recognises out of the box -- `token-claims`,
/// `revocation-claims`, `handle-claims`, and `room-notice-claims` are the
/// self-certifying payload shapes this codebase already defines. A caller
/// extending recognised kinds (e.g. an application-defined one) supplies
/// its own recogniser rather than this crate growing a closed list.
pub const KNOWN_KINDS: &[&str] = &[
    "capability-token",
    "revocation-entry",
    "handle-record",
    "room-notice",
];

/// A participant's decision on whether to authorise a `threshold-subject`.
/// Deliberately not a bare `bool`: a `Refuse` MUST carry a reason so the
/// coordinator (and, ideally, a human reviewing a denied session) can
/// understand why, matching this spec's own fail-closed-with-a-reason
/// idiom elsewhere (`manage-error.message`, `threshold-abort.reason`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubjectDecision {
    Authorise,
    Refuse { reason: String },
}

/// The verifier obligation `spec/threshold.cddl` states directly: an
/// unrecognised `kind` MUST be refused, never signed blindly. This is the
/// fail-closed default every content policy is checked against BEFORE any
/// kind-specific review runs; a caller's own policy closure only ever gets
/// a chance to run for a kind it (or [`KNOWN_KINDS`]) actually recognises.
pub fn refuse_unrecognised_kind(
    subject: &ThresholdSubject,
    known: &[&str],
) -> Option<SubjectDecision> {
    if known.contains(&subject.kind.as_str()) {
        None
    } else {
        Some(SubjectDecision::Refuse {
            reason: format!(
                "unrecognised threshold-subject.kind {:?} -- refusing to sign",
                subject.kind
            ),
        })
    }
}

/// Reconstructs the exact bytes this participant signs its round-1
/// commitment (and, transitively, its round-2 share) over -- the
/// Sig_structure built from THIS participant's own decoding of
/// `protected`/`payload`, never a coordinator-supplied to-be-signed blob.
pub fn to_be_signed(subject: &ThresholdSubject) -> Vec<u8> {
    sig_structure(&subject.protected, &subject.payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subject(kind: &str) -> ThresholdSubject {
        ThresholdSubject {
            kind: kind.to_owned(),
            protected: vec![0xa1, 0x01, 0x27],
            payload: vec![0xa0],
        }
    }

    #[test]
    fn known_kinds_are_not_refused_by_the_generic_check() {
        for kind in KNOWN_KINDS {
            assert_eq!(refuse_unrecognised_kind(&subject(kind), KNOWN_KINDS), None);
        }
    }

    #[test]
    fn an_unrecognised_kind_is_refused_with_a_reason() {
        let decision =
            refuse_unrecognised_kind(&subject("x-something-nobody-anticipated"), KNOWN_KINDS);
        match decision {
            Some(SubjectDecision::Refuse { reason }) => assert!(reason.contains("unrecognised")),
            other => panic!("expected a Refuse decision, got {other:?}"),
        }
    }

    #[test]
    fn to_be_signed_matches_the_shared_cose_construction_directly() {
        let s = subject("capability-token");
        assert_eq!(to_be_signed(&s), sig_structure(&s.protected, &s.payload));
    }

    #[test]
    fn different_payloads_produce_different_to_be_signed_bytes() {
        let mut a = subject("capability-token");
        let mut b = a.clone();
        b.payload = vec![0xa1, 0x00, 0x00];
        a.payload = vec![0xa0];
        assert_ne!(to_be_signed(&a), to_be_signed(&b));
    }
}
