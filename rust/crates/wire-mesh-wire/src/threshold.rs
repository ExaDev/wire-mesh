//! `threshold.cddl` — the `$manage-command-params` members for
//! `exadev.io/threshold` (wire-mesh#29/#171): the six manage-command verbs
//! covering FROST(Ed25519) threshold signing's two-round commit/sign
//! protocol, session abort, and the collapsed DKG/reshare
//! keygen-round1/round2/confirm triplet. Pure codec mirroring `webrtc.rs`'s
//! own pattern: nothing in this module performs any cryptography or
//! session orchestration, it only gets a verb's params on and off the wire
//! in the exact CDE byte layout `spec/threshold.cddl` and the generated TS
//! codec already agree on.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::identity::{device_id_from, DeviceId};
use crate::strict;

/// `threshold-subject = { kind: tstr, protected: bstr, payload: bstr }`.
/// CDE key order: `kind` (4), `payload` (7), `protected` (9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdSubject {
    pub kind: String,
    pub protected: Vec<u8>,
    pub payload: Vec<u8>,
}

impl Encode<()> for ThresholdSubject {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("kind")?.str(&self.kind)?;
        e.str("payload")?.bytes(&self.payload)?;
        e.str("protected")?.bytes(&self.protected)?;
        e.ok()
    }
}

impl Decode<'_, ()> for ThresholdSubject {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        threshold_subject_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn threshold_subject_from(d: &mut Decoder<'_>) -> Result<ThresholdSubject, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut kind: Option<String> = None;
    let mut protected: Option<Vec<u8>> = None;
    let mut payload: Option<Vec<u8>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "kind" => strict::set_once(&mut kind, strict::text_value(d)?)?,
            "protected" => strict::set_once(&mut protected, strict::bytes_value(d)?)?,
            "payload" => strict::set_once(&mut payload, strict::bytes_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(ThresholdSubject {
        kind: kind.ok_or(DecodeError::MissingField("kind"))?,
        protected: protected.ok_or(DecodeError::MissingField("protected"))?,
        payload: payload.ok_or(DecodeError::MissingField("payload"))?,
    })
}

/// `threshold-commitment = { participant: device-id, hiding: bstr, binding: bstr }`.
/// CDE key order: `hiding` (6), `binding` (7), `participant` (11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdCommitment {
    pub participant: DeviceId,
    pub hiding: Vec<u8>,
    pub binding: Vec<u8>,
}

impl Encode<()> for ThresholdCommitment {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("hiding")?.bytes(&self.hiding)?;
        e.str("binding")?.bytes(&self.binding)?;
        e.str("participant")?;
        self.participant.encode(e, ctx)?;
        e.ok()
    }
}

impl Decode<'_, ()> for ThresholdCommitment {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        threshold_commitment_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn threshold_commitment_from(
    d: &mut Decoder<'_>,
) -> Result<ThresholdCommitment, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut participant: Option<DeviceId> = None;
    let mut hiding: Option<Vec<u8>> = None;
    let mut binding: Option<Vec<u8>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "participant" => strict::set_once(&mut participant, device_id_from(d)?)?,
            "hiding" => strict::set_once(&mut hiding, strict::bytes_value(d)?)?,
            "binding" => strict::set_once(&mut binding, strict::bytes_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(ThresholdCommitment {
        participant: participant.ok_or(DecodeError::MissingField("participant"))?,
        hiding: hiding.ok_or(DecodeError::MissingField("hiding"))?,
        binding: binding.ok_or(DecodeError::MissingField("binding"))?,
    })
}

/// `threshold-commit = { verb: "threshold.commit", "session-id": session-id,
/// group: device-id, subject: threshold-subject, deadline: uint }`.
/// CDE key order: `verb` (4), `group` (5), `subject` (7), `deadline` (8),
/// `session-id` (10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdCommit {
    pub session_id: u64,
    pub group: DeviceId,
    pub subject: ThresholdSubject,
    pub deadline: u64,
}

impl ThresholdCommit {
    pub const VERB: &'static str = "threshold.commit";
}

impl Encode<()> for ThresholdCommit {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(5)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("group")?;
        self.group.encode(e, ctx)?;
        e.str("subject")?;
        self.subject.encode(e, ctx)?;
        e.str("deadline")?.u64(self.deadline)?;
        e.str("session-id")?.u64(self.session_id)?;
        e.ok()
    }
}

impl ThresholdCommit {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session_id: Option<u64> = None;
        let mut group: Option<DeviceId> = None;
        let mut subject: Option<ThresholdSubject> = None;
        let mut deadline: Option<u64> = None;
        param::decode_params_map(d, ThresholdCommit::VERB, &mut |d, key| {
            match key {
                "session-id" => strict::set_once(&mut session_id, strict::uint_value(d)?)?,
                "group" => strict::set_once(&mut group, device_id_from(d)?)?,
                "subject" => strict::set_once(&mut subject, threshold_subject_from(d)?)?,
                "deadline" => strict::set_once(&mut deadline, strict::uint_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(ThresholdCommit {
            session_id: session_id.ok_or(DecodeError::MissingField("session-id"))?,
            group: group.ok_or(DecodeError::MissingField("group"))?,
            subject: subject.ok_or(DecodeError::MissingField("subject"))?,
            deadline: deadline.ok_or(DecodeError::MissingField("deadline"))?,
        })
    }
}

/// `threshold-sign = { verb: "threshold.sign", "session-id": session-id,
/// commitments: [* threshold-commitment] }`. CDE key order: `verb` (4),
/// `session-id` (10), `commitments` (11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdSign {
    pub session_id: u64,
    pub commitments: Vec<ThresholdCommitment>,
}

impl ThresholdSign {
    pub const VERB: &'static str = "threshold.sign";
}

impl Encode<()> for ThresholdSign {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("session-id")?.u64(self.session_id)?;
        e.str("commitments")?.array(self.commitments.len() as u64)?;
        for commitment in &self.commitments {
            commitment.encode(e, ctx)?;
        }
        e.ok()
    }
}

impl ThresholdSign {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session_id: Option<u64> = None;
        let mut commitments: Option<Vec<ThresholdCommitment>> = None;
        param::decode_params_map(d, ThresholdSign::VERB, &mut |d, key| {
            match key {
                "session-id" => strict::set_once(&mut session_id, strict::uint_value(d)?)?,
                "commitments" => {
                    let count = strict::definite_array(d)?;
                    let mut list = Vec::new();
                    for _ in 0..count {
                        list.push(threshold_commitment_from(d)?);
                    }
                    strict::set_once(&mut commitments, list)?
                }
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(ThresholdSign {
            session_id: session_id.ok_or(DecodeError::MissingField("session-id"))?,
            commitments: commitments.ok_or(DecodeError::MissingField("commitments"))?,
        })
    }
}

/// `threshold-abort = { verb: "threshold.abort", "session-id": session-id,
/// ? reason: tstr }`. CDE key order: `verb` (4), `reason` (6, optional),
/// `session-id` (10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdAbort {
    pub session_id: u64,
    pub reason: Option<String>,
}

impl ThresholdAbort {
    pub const VERB: &'static str = "threshold.abort";
}

impl Encode<()> for ThresholdAbort {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 2 + usize::from(self.reason.is_some());
        e.map(len as u64)?;
        e.str("verb")?.str(Self::VERB)?;
        if let Some(reason) = &self.reason {
            e.str("reason")?.str(reason)?;
        }
        e.str("session-id")?.u64(self.session_id)?;
        e.ok()
    }
}

impl ThresholdAbort {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session_id: Option<u64> = None;
        let mut reason: Option<String> = None;
        param::decode_params_map(d, ThresholdAbort::VERB, &mut |d, key| {
            match key {
                "session-id" => strict::set_once(&mut session_id, strict::uint_value(d)?)?,
                "reason" => strict::set_once(&mut reason, strict::text_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(ThresholdAbort {
            session_id: session_id.ok_or(DecodeError::MissingField("session-id"))?,
            reason,
        })
    }
}

/// `threshold-keygen-round1 = { verb: "threshold.keygen-round1",
/// "session-id": session-id, threshold: uint, participants: [* device-id],
/// commitment: [* bstr], ? "proof-of-knowledge": bstr,
/// ? "existing-group-key": bstr }`. CDE key order: `verb` (4), `threshold`
/// (9), `commitment` (10), `session-id` (10; bytewise after `commitment`),
/// `participants` (12), `existing-group-key` (18), `proof-of-knowledge`
/// (18; bytewise after `existing-group-key`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdKeygenRound1 {
    pub session_id: u64,
    pub threshold: u64,
    pub participants: Vec<DeviceId>,
    pub commitment: Vec<Vec<u8>>,
    pub proof_of_knowledge: Option<Vec<u8>>,
    pub existing_group_key: Option<Vec<u8>>,
}

impl ThresholdKeygenRound1 {
    pub const VERB: &'static str = "threshold.keygen-round1";
}

impl Encode<()> for ThresholdKeygenRound1 {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 5
            + usize::from(self.proof_of_knowledge.is_some())
            + usize::from(self.existing_group_key.is_some());
        e.map(len as u64)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("threshold")?.u64(self.threshold)?;
        e.str("commitment")?.array(self.commitment.len() as u64)?;
        for coefficient in &self.commitment {
            e.bytes(coefficient)?;
        }
        e.str("session-id")?.u64(self.session_id)?;
        e.str("participants")?
            .array(self.participants.len() as u64)?;
        for participant in &self.participants {
            participant.encode(e, ctx)?;
        }
        if let Some(existing_group_key) = &self.existing_group_key {
            e.str("existing-group-key")?.bytes(existing_group_key)?;
        }
        if let Some(proof_of_knowledge) = &self.proof_of_knowledge {
            e.str("proof-of-knowledge")?.bytes(proof_of_knowledge)?;
        }
        e.ok()
    }
}

impl ThresholdKeygenRound1 {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session_id: Option<u64> = None;
        let mut threshold: Option<u64> = None;
        let mut participants: Option<Vec<DeviceId>> = None;
        let mut commitment: Option<Vec<Vec<u8>>> = None;
        let mut proof_of_knowledge: Option<Vec<u8>> = None;
        let mut existing_group_key: Option<Vec<u8>> = None;
        param::decode_params_map(d, ThresholdKeygenRound1::VERB, &mut |d, key| {
            match key {
                "session-id" => strict::set_once(&mut session_id, strict::uint_value(d)?)?,
                "threshold" => strict::set_once(&mut threshold, strict::uint_value(d)?)?,
                "participants" => {
                    let count = strict::definite_array(d)?;
                    let mut list = Vec::new();
                    for _ in 0..count {
                        list.push(device_id_from(d)?);
                    }
                    strict::set_once(&mut participants, list)?
                }
                "commitment" => {
                    let count = strict::definite_array(d)?;
                    let mut list = Vec::new();
                    for _ in 0..count {
                        list.push(strict::bytes_value(d)?);
                    }
                    strict::set_once(&mut commitment, list)?
                }
                "proof-of-knowledge" => {
                    strict::set_once(&mut proof_of_knowledge, strict::bytes_value(d)?)?
                }
                "existing-group-key" => {
                    strict::set_once(&mut existing_group_key, strict::bytes_value(d)?)?
                }
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(ThresholdKeygenRound1 {
            session_id: session_id.ok_or(DecodeError::MissingField("session-id"))?,
            threshold: threshold.ok_or(DecodeError::MissingField("threshold"))?,
            participants: participants.ok_or(DecodeError::MissingField("participants"))?,
            commitment: commitment.ok_or(DecodeError::MissingField("commitment"))?,
            proof_of_knowledge,
            existing_group_key,
        })
    }
}

/// `threshold-keygen-round2 = { verb: "threshold.keygen-round2",
/// "session-id": session-id, share: bstr }`. CDE key order: `verb` (4),
/// `share` (5), `session-id` (10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdKeygenRound2 {
    pub session_id: u64,
    pub share: Vec<u8>,
}

impl ThresholdKeygenRound2 {
    pub const VERB: &'static str = "threshold.keygen-round2";
}

impl Encode<()> for ThresholdKeygenRound2 {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("share")?.bytes(&self.share)?;
        e.str("session-id")?.u64(self.session_id)?;
        e.ok()
    }
}

impl ThresholdKeygenRound2 {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session_id: Option<u64> = None;
        let mut share: Option<Vec<u8>> = None;
        param::decode_params_map(d, ThresholdKeygenRound2::VERB, &mut |d, key| {
            match key {
                "session-id" => strict::set_once(&mut session_id, strict::uint_value(d)?)?,
                "share" => strict::set_once(&mut share, strict::bytes_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(ThresholdKeygenRound2 {
            session_id: session_id.ok_or(DecodeError::MissingField("session-id"))?,
            share: share.ok_or(DecodeError::MissingField("share"))?,
        })
    }
}

/// `threshold-keygen-confirm = { verb: "threshold.keygen-confirm",
/// "session-id": session-id, "transcript-digest": bstr, "group-key": bstr }`.
/// CDE key order: `verb` (4), `group-key` (9), `session-id` (10),
/// `transcript-digest` (17).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdKeygenConfirm {
    pub session_id: u64,
    pub transcript_digest: Vec<u8>,
    pub group_key: Vec<u8>,
}

impl ThresholdKeygenConfirm {
    pub const VERB: &'static str = "threshold.keygen-confirm";
}

impl Encode<()> for ThresholdKeygenConfirm {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(4)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("group-key")?.bytes(&self.group_key)?;
        e.str("session-id")?.u64(self.session_id)?;
        e.str("transcript-digest")?.bytes(&self.transcript_digest)?;
        e.ok()
    }
}

impl ThresholdKeygenConfirm {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session_id: Option<u64> = None;
        let mut transcript_digest: Option<Vec<u8>> = None;
        let mut group_key: Option<Vec<u8>> = None;
        param::decode_params_map(d, ThresholdKeygenConfirm::VERB, &mut |d, key| {
            match key {
                "session-id" => strict::set_once(&mut session_id, strict::uint_value(d)?)?,
                "transcript-digest" => {
                    strict::set_once(&mut transcript_digest, strict::bytes_value(d)?)?
                }
                "group-key" => strict::set_once(&mut group_key, strict::bytes_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(ThresholdKeygenConfirm {
            session_id: session_id.ok_or(DecodeError::MissingField("session-id"))?,
            transcript_digest: transcript_digest
                .ok_or(DecodeError::MissingField("transcript-digest"))?,
            group_key: group_key.ok_or(DecodeError::MissingField("group-key"))?,
        })
    }
}

/// Shared decode helper for the `$manage-command-params` members defined in
/// this module, mirroring `webrtc`'s and `exec`'s own private `param`
/// submodule.
pub(crate) mod param {
    use super::*;

    pub(super) fn decode_params_map<'b>(
        d: &mut Decoder<'b>,
        expected_verb: &'static str,
        consume: &mut dyn FnMut(&mut Decoder<'b>, &str) -> Result<(), DecodeError>,
    ) -> Result<(), DecodeError> {
        let mut map = strict::MapDecoder::new(d)?;
        let mut saw_verb = false;
        while let Some(key) = map.next_key(d)? {
            if key == "verb" {
                strict::literal(d, expected_verb)?;
                saw_verb = true;
            } else {
                consume(d, key)?;
            }
        }
        if !saw_verb {
            return Err(DecodeError::MissingField("verb"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_order_positions(bytes: &[u8], keys: &[&str]) -> Vec<usize> {
        keys.iter()
            .map(|k| {
                bytes
                    .windows(k.len())
                    .position(|w| w == k.as_bytes())
                    .unwrap_or_else(|| panic!("key {k:?} present"))
            })
            .collect()
    }

    fn assert_sorted(bytes: &[u8], keys: &[&str]) {
        let order = key_order_positions(bytes, keys);
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(order, sorted, "keys {keys:?} not in CDE order");
    }

    fn device_id(byte: u8) -> DeviceId {
        DeviceId([byte; 32])
    }

    #[test]
    fn threshold_subject_round_trip_and_key_order() {
        let subject = ThresholdSubject {
            kind: "capability-token".to_owned(),
            protected: vec![1, 2, 3],
            payload: vec![4, 5, 6],
        };
        let bytes = minicbor::to_vec(&subject).expect("encode");
        let back: ThresholdSubject = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, subject);
        assert_sorted(&bytes, &["kind", "payload", "protected"]);
    }

    #[test]
    fn threshold_commitment_round_trip_and_key_order() {
        let commitment = ThresholdCommitment {
            participant: device_id(1),
            hiding: vec![1],
            binding: vec![2],
        };
        let bytes = minicbor::to_vec(&commitment).expect("encode");
        let back: ThresholdCommitment = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, commitment);
        assert_sorted(&bytes, &["hiding", "binding", "participant"]);
    }

    #[test]
    fn threshold_commit_round_trip_and_key_order() {
        let commit = ThresholdCommit {
            session_id: 7,
            group: device_id(9),
            subject: ThresholdSubject {
                kind: "room-notice".to_owned(),
                protected: vec![1],
                payload: vec![2],
            },
            deadline: 1_700_000_000_000,
        };
        let bytes = minicbor::to_vec(&commit).expect("encode");
        let back = ThresholdCommit::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, commit);
        assert_sorted(
            &bytes,
            &["verb", "group", "subject", "deadline", "session-id"],
        );
    }

    #[test]
    fn threshold_sign_round_trip_with_multiple_commitments() {
        let sign = ThresholdSign {
            session_id: 3,
            commitments: vec![
                ThresholdCommitment {
                    participant: device_id(1),
                    hiding: vec![1],
                    binding: vec![2],
                },
                ThresholdCommitment {
                    participant: device_id(2),
                    hiding: vec![3],
                    binding: vec![4],
                },
            ],
        };
        let bytes = minicbor::to_vec(&sign).expect("encode");
        let back = ThresholdSign::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, sign);
        assert_sorted(&bytes, &["verb", "session-id", "commitments"]);
    }

    #[test]
    fn threshold_sign_rejects_a_non_array_commitments_field() {
        // A definite map { "verb": "threshold.sign", "session-id": 1, "commitments": 0 } -- commitments as a uint instead of an array.
        let mut bytes: Vec<u8> = vec![0xa3];
        bytes.extend_from_slice(&minicbor::to_vec("verb").unwrap());
        bytes.extend_from_slice(&minicbor::to_vec("threshold.sign").unwrap());
        bytes.extend_from_slice(&minicbor::to_vec("commitments").unwrap());
        bytes.push(0x00);
        bytes.extend_from_slice(&minicbor::to_vec("session-id").unwrap());
        bytes.push(0x01);
        assert!(ThresholdSign::from_map(&mut Decoder::new(&bytes)).is_err());
    }

    #[test]
    fn threshold_abort_round_trips_with_and_without_reason() {
        let with_reason = ThresholdAbort {
            session_id: 5,
            reason: Some("participant unavailable".to_owned()),
        };
        let bytes = minicbor::to_vec(&with_reason).expect("encode");
        let back = ThresholdAbort::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, with_reason);
        assert_sorted(&bytes, &["verb", "reason", "session-id"]);

        let without_reason = ThresholdAbort {
            session_id: 5,
            reason: None,
        };
        let bytes = minicbor::to_vec(&without_reason).expect("encode");
        assert_eq!(bytes[0], 0xa2);
        let back = ThresholdAbort::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, without_reason);
    }

    #[test]
    fn threshold_keygen_round1_round_trips_fresh_dkg_shape() {
        // Fresh DKG: proof-of-knowledge present, existing-group-key absent.
        let round1 = ThresholdKeygenRound1 {
            session_id: 1,
            threshold: 2,
            participants: vec![device_id(1), device_id(2), device_id(3)],
            commitment: vec![vec![1, 2], vec![3, 4]],
            proof_of_knowledge: Some(vec![9, 9]),
            existing_group_key: None,
        };
        let bytes = minicbor::to_vec(&round1).expect("encode");
        let back = ThresholdKeygenRound1::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, round1);
        assert_sorted(
            &bytes,
            &[
                "verb",
                "threshold",
                "commitment",
                "session-id",
                "participants",
                "proof-of-knowledge",
            ],
        );
    }

    #[test]
    fn threshold_keygen_round1_round_trips_reshare_shape() {
        // Reshare: existing-group-key present, proof-of-knowledge absent.
        let round1 = ThresholdKeygenRound1 {
            session_id: 2,
            threshold: 2,
            participants: vec![device_id(1), device_id(2)],
            commitment: vec![vec![1]],
            proof_of_knowledge: None,
            existing_group_key: Some(vec![7; 32]),
        };
        let bytes = minicbor::to_vec(&round1).expect("encode");
        let back = ThresholdKeygenRound1::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, round1);
        assert_sorted(
            &bytes,
            &[
                "verb",
                "threshold",
                "commitment",
                "session-id",
                "participants",
                "existing-group-key",
            ],
        );
    }

    #[test]
    fn threshold_keygen_round1_round_trips_with_both_optionals_present() {
        let round1 = ThresholdKeygenRound1 {
            session_id: 2,
            threshold: 2,
            participants: vec![device_id(1)],
            commitment: vec![vec![1]],
            proof_of_knowledge: Some(vec![1]),
            existing_group_key: Some(vec![2]),
        };
        let bytes = minicbor::to_vec(&round1).expect("encode");
        assert_eq!(bytes[0], 0xa7);
        let back = ThresholdKeygenRound1::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, round1);
        assert_sorted(
            &bytes,
            &[
                "verb",
                "threshold",
                "commitment",
                "session-id",
                "participants",
                "existing-group-key",
                "proof-of-knowledge",
            ],
        );
    }

    #[test]
    fn threshold_keygen_round2_round_trip() {
        let round2 = ThresholdKeygenRound2 {
            session_id: 4,
            share: vec![1, 2, 3, 4],
        };
        let bytes = minicbor::to_vec(&round2).expect("encode");
        let back = ThresholdKeygenRound2::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, round2);
        assert_sorted(&bytes, &["verb", "share", "session-id"]);
    }

    #[test]
    fn threshold_keygen_confirm_round_trip() {
        let confirm = ThresholdKeygenConfirm {
            session_id: 6,
            transcript_digest: vec![0xaa; 32],
            group_key: vec![0xbb; 32],
        };
        let bytes = minicbor::to_vec(&confirm).expect("encode");
        let back = ThresholdKeygenConfirm::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, confirm);
        assert_sorted(
            &bytes,
            &["verb", "group-key", "session-id", "transcript-digest"],
        );
    }

    #[test]
    fn typed_params_reject_unknown_keys() {
        // { "verb": "threshold.commit", "session-id": 1, "bogus": true } --
        // missing group/subject/deadline too, but the unknown key must
        // surface regardless of what else is absent.
        let mut bytes: Vec<u8> = vec![0xa3];
        bytes.extend_from_slice(&minicbor::to_vec("verb").unwrap());
        bytes.extend_from_slice(&minicbor::to_vec("threshold.commit").unwrap());
        bytes.extend_from_slice(&minicbor::to_vec("bogus").unwrap());
        bytes.push(0xf5);
        bytes.extend_from_slice(&minicbor::to_vec("session-id").unwrap());
        bytes.push(0x01);
        assert!(ThresholdCommit::from_map(&mut Decoder::new(&bytes)).is_err());
    }

    #[test]
    fn wrong_verb_literal_is_rejected() {
        let sign_bytes = minicbor::to_vec(&ThresholdSign {
            session_id: 1,
            commitments: vec![],
        })
        .expect("encode");
        // Decoding a threshold-sign payload as ThresholdCommit must fail: the verb literal doesn't match.
        assert!(ThresholdCommit::from_map(&mut Decoder::new(&sign_bytes)).is_err());
    }
}
