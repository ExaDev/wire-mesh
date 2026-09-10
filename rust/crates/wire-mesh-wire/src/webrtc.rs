//! `webrtc.cddl` — the `$manage-command-params` members for core/webrtc:
//! SDP offer/answer and ICE candidate exchange, riding manage-request
//! frames the same way core/exec's pty.*/proc.* commands do. Pure codec
//! mirroring: nothing in this crate performs any actual WebRTC signaling
//! behavior, an unrecognized verb already fell through losslessly to
//! `ManageParams::Json` before this module existed.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::strict;

/// `webrtc-offer = { verb: "webrtc.offer", "negotiation-id": uint, sdp: tstr }`.
/// CDE key order: `sdp` (3), `verb` (4), `negotiation-id` (14).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebrtcOffer {
    pub negotiation_id: u64,
    pub sdp: String,
}

impl WebrtcOffer {
    pub const VERB: &'static str = "webrtc.offer";
}

impl Encode<()> for WebrtcOffer {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("sdp")?.str(&self.sdp)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("negotiation-id")?.u64(self.negotiation_id)?;
        e.ok()
    }
}

impl WebrtcOffer {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut negotiation_id: Option<u64> = None;
        let mut sdp: Option<String> = None;
        param::decode_params_map(d, WebrtcOffer::VERB, &mut |d, key| {
            match key {
                "negotiation-id" => strict::set_once(&mut negotiation_id, strict::uint_value(d)?)?,
                "sdp" => strict::set_once(&mut sdp, strict::text_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(WebrtcOffer {
            negotiation_id: negotiation_id.ok_or(DecodeError::MissingField("negotiation-id"))?,
            sdp: sdp.ok_or(DecodeError::MissingField("sdp"))?,
        })
    }
}

/// `webrtc-answer = { verb: "webrtc.answer", "negotiation-id": uint, sdp: tstr }`.
/// Same key set and CDE order as [`WebrtcOffer`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebrtcAnswer {
    pub negotiation_id: u64,
    pub sdp: String,
}

impl WebrtcAnswer {
    pub const VERB: &'static str = "webrtc.answer";
}

impl Encode<()> for WebrtcAnswer {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("sdp")?.str(&self.sdp)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("negotiation-id")?.u64(self.negotiation_id)?;
        e.ok()
    }
}

impl WebrtcAnswer {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut negotiation_id: Option<u64> = None;
        let mut sdp: Option<String> = None;
        param::decode_params_map(d, WebrtcAnswer::VERB, &mut |d, key| {
            match key {
                "negotiation-id" => strict::set_once(&mut negotiation_id, strict::uint_value(d)?)?,
                "sdp" => strict::set_once(&mut sdp, strict::text_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(WebrtcAnswer {
            negotiation_id: negotiation_id.ok_or(DecodeError::MissingField("negotiation-id"))?,
            sdp: sdp.ok_or(DecodeError::MissingField("sdp"))?,
        })
    }
}

/// `webrtc-ice-candidate = { verb: "webrtc.ice-candidate", "negotiation-id": uint, ? candidate: ice-candidate-init }`.
///
/// An absent `candidate` is the end-of-candidates sentinel (what the
/// browser signals as `event.candidate === null` when ICE gathering
/// completes) -- collapsing "null" and "absent" onto the wire is
/// deliberate, nothing downstream distinguishes them. CDE key order:
/// `verb` (4), `candidate` (9), `negotiation-id` (14).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebrtcIceCandidate {
    pub negotiation_id: u64,
    pub candidate: Option<IceCandidateInit>,
}

impl WebrtcIceCandidate {
    pub const VERB: &'static str = "webrtc.ice-candidate";
}

impl Encode<()> for WebrtcIceCandidate {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 2 + usize::from(self.candidate.is_some());
        e.map(len as u64)?;
        e.str("verb")?.str(Self::VERB)?;
        if let Some(candidate) = &self.candidate {
            e.str("candidate")?.encode(candidate)?;
        }
        e.str("negotiation-id")?.u64(self.negotiation_id)?;
        e.ok()
    }
}

impl WebrtcIceCandidate {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut negotiation_id: Option<u64> = None;
        let mut candidate: Option<IceCandidateInit> = None;
        param::decode_params_map(d, WebrtcIceCandidate::VERB, &mut |d, key| {
            match key {
                "negotiation-id" => strict::set_once(&mut negotiation_id, strict::uint_value(d)?)?,
                "candidate" => strict::set_once(&mut candidate, ice_candidate_init_from(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(WebrtcIceCandidate {
            negotiation_id: negotiation_id.ok_or(DecodeError::MissingField("negotiation-id"))?,
            candidate,
        })
    }
}

/// `ice-candidate-init = { candidate: tstr, ? "sdp-mid": tstr, ? "sdp-m-line-index": uint, ? "username-fragment": tstr }`.
///
/// Mirrors `RTCIceCandidateInit` field-for-field. CDE key order: `sdp-mid`
/// (7), `candidate` (9), `sdp-m-line-index` (16), `username-fragment` (18).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IceCandidateInit {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_m_line_index: Option<u64>,
    pub username_fragment: Option<String>,
}

impl Encode<()> for IceCandidateInit {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 1
            + usize::from(self.sdp_mid.is_some())
            + usize::from(self.sdp_m_line_index.is_some())
            + usize::from(self.username_fragment.is_some());
        e.map(len as u64)?;
        if let Some(sdp_mid) = &self.sdp_mid {
            e.str("sdp-mid")?.str(sdp_mid)?;
        }
        e.str("candidate")?.str(&self.candidate)?;
        if let Some(sdp_m_line_index) = self.sdp_m_line_index {
            e.str("sdp-m-line-index")?.u64(sdp_m_line_index)?;
        }
        if let Some(username_fragment) = &self.username_fragment {
            e.str("username-fragment")?.str(username_fragment)?;
        }
        e.ok()
    }
}

impl Decode<'_, ()> for IceCandidateInit {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        ice_candidate_init_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn ice_candidate_init_from(
    d: &mut Decoder<'_>,
) -> Result<IceCandidateInit, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut candidate: Option<String> = None;
    let mut sdp_mid: Option<String> = None;
    let mut sdp_m_line_index: Option<u64> = None;
    let mut username_fragment: Option<String> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "candidate" => strict::set_once(&mut candidate, strict::text_value(d)?)?,
            "sdp-mid" => strict::set_once(&mut sdp_mid, strict::text_value(d)?)?,
            "sdp-m-line-index" => strict::set_once(&mut sdp_m_line_index, strict::uint_value(d)?)?,
            "username-fragment" => {
                strict::set_once(&mut username_fragment, strict::text_value(d)?)?
            }
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(IceCandidateInit {
        candidate: candidate.ok_or(DecodeError::MissingField("candidate"))?,
        sdp_mid,
        sdp_m_line_index,
        username_fragment,
    })
}

/// Shared decode helper for the `$manage-command-params` members defined in
/// this module, mirroring `exec`'s own private `param` submodule.
pub(crate) mod param {
    use super::*;

    /// Decode one params map, checking the `verb` literal and rejecting
    /// keys the caller's closure did not consume (the closure's own `_`
    /// arm reports the unknown key).
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

    fn encode<T>(value: &T) -> T
    where
        T: Encode<()> + PartialEq + core::fmt::Debug + for<'a> Decode<'a, ()>,
    {
        let bytes = minicbor::to_vec(value).expect("encode");
        minicbor::decode(&bytes).expect("decode")
    }

    #[test]
    fn webrtc_offer_round_trip_and_key_order() {
        let offer = WebrtcOffer {
            negotiation_id: 1,
            sdp: "v=0\r\n".to_owned(),
        };
        let bytes = minicbor::to_vec(&offer).expect("encode");
        let back = WebrtcOffer::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, offer);
        let sdp_at = bytes.windows(3).position(|w| w == b"sdp").expect("sdp");
        let verb_at = bytes.windows(4).position(|w| w == b"verb").expect("verb");
        let neg_at = bytes
            .windows(14)
            .position(|w| w == b"negotiation-id")
            .expect("negotiation-id");
        assert!(sdp_at < verb_at && verb_at < neg_at);
    }

    #[test]
    fn webrtc_answer_round_trip() {
        let answer = WebrtcAnswer {
            negotiation_id: 2,
            sdp: "v=0\r\n".to_owned(),
        };
        let bytes = minicbor::to_vec(&answer).expect("encode");
        let back = WebrtcAnswer::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, answer);
    }

    #[test]
    fn webrtc_ice_candidate_round_trip_with_candidate() {
        let ice = WebrtcIceCandidate {
            negotiation_id: 1,
            candidate: Some(IceCandidateInit {
                candidate: "candidate:1 1 UDP 2130706431 203.0.113.5 54400 typ host".to_owned(),
                sdp_mid: Some("0".to_owned()),
                sdp_m_line_index: Some(0),
                username_fragment: Some("abcd".to_owned()),
            }),
        };
        let bytes = minicbor::to_vec(&ice).expect("encode");
        let back = WebrtcIceCandidate::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, ice);
    }

    #[test]
    fn webrtc_ice_candidate_end_of_candidates_has_no_candidate_key() {
        let ice = WebrtcIceCandidate {
            negotiation_id: 1,
            candidate: None,
        };
        let bytes = minicbor::to_vec(&ice).expect("encode");
        // A definite map of 2 entries (verb, negotiation-id only) -- the "candidate" key itself is absent, not merely null. (The verb literal "webrtc.ice-candidate" itself contains the substring "candidate", so this checks the map's own key count rather than scanning the encoded bytes for that substring.)
        assert_eq!(bytes[0], 0xa2);
        let back = WebrtcIceCandidate::from_map(&mut Decoder::new(&bytes)).expect("decode");
        assert_eq!(back, ice);
    }

    #[test]
    fn ice_candidate_init_key_order() {
        let init = IceCandidateInit {
            candidate: "candidate:1 1 UDP 2130706431 203.0.113.5 54400 typ host".to_owned(),
            sdp_mid: Some("0".to_owned()),
            sdp_m_line_index: Some(0),
            username_fragment: Some("abcd".to_owned()),
        };
        assert_eq!(&encode(&init), &init);
        let bytes = minicbor::to_vec(&init).expect("encode");
        let order: Vec<usize> = [
            "sdp-mid",
            "candidate",
            "sdp-m-line-index",
            "username-fragment",
        ]
        .iter()
        .map(|k| {
            bytes
                .windows(k.len())
                .position(|w| w == k.as_bytes())
                .expect("key present")
        })
        .collect();
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(order, sorted);
    }

    #[test]
    fn typed_params_reject_unknown_keys() {
        // {"verb": "webrtc.offer", "negotiation-id": 1, "sdp": "x", "bogus": true}
        let bytes: Vec<u8> = [
            0xa4u8, 0x64, b'v', b'e', b'r', b'b', 0x6c, b'w', b'e', b'b', b'r', b't', b'c', b'.',
            b'o', b'f', b'f', b'e', b'r', 0x6e, b'n', b'e', b'g', b'o', b't', b'i', b'a', b't',
            b'i', b'o', b'n', b'-', b'i', b'd', 0x01, 0x63, b's', b'd', b'p', 0x61, b'x', 0x65,
            b'b', b'o', b'g', b'u', b's', 0xf5,
        ]
        .to_vec();
        assert!(WebrtcOffer::from_map(&mut Decoder::new(&bytes)).is_err());
    }
}
