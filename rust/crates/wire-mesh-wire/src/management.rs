//! `management.cddl` — verb dispatch, manage request/response, and the
//! redesigned signed revocation entries.
//!
//! `$manage-command-params` is a socket, not a closed union: core/exec's
//! pty.*/proc.* commands extend it from their own module (see
//! [`crate::exec`]), and [`ManageParams::Json`] is the catch-all arm so a
//! future domain's params decode without editing this closed core — an
//! unknown verb survives the wire exactly as it was sent.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::exec::{
    ExecList, ProcKill, ProcSignal, ProcSpawn, PtyKill, PtyResize, PtySpawn, PtyWrite,
};
use crate::identity::{device_id_from, DeviceId, IdentityKey};
use crate::strict;
use crate::tokens::{scope_from, CapabilityScope, CapabilityVerb, CoseSign1};
use crate::value::{CanonicalMap, CborValue, CdeKey, CdeMapBuilder};
use crate::webrtc::{WebrtcAnswer, WebrtcIceCandidate, WebrtcOffer};

/// `manage-command = { verb: capability-verb, params: $manage-command-params }`.
///
/// Note the two verbs: the outer is the *capability* verb (e.g. `exec:pty`)
/// naming the authority being exercised; the params map carries its own
/// inner command verb (`pty.spawn`) identifying the shape. CDE key order:
/// `verb` (5), `params` (7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManageCommand {
    pub verb: CapabilityVerb,
    pub params: ManageParams,
}

impl Encode<()> for ManageCommand {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("verb")?.str(&self.verb.0)?;
        e.str("params")?.encode(&self.params)?;
        e.ok()
    }
}

impl Decode<'_, ()> for ManageCommand {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        manage_command_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn manage_command_from(d: &mut Decoder<'_>) -> Result<ManageCommand, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut verb: Option<String> = None;
    let mut params: Option<ManageParams> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "verb" => strict::set_once(&mut verb, strict::text_value(d)?)?,
            "params" => strict::set_once(&mut params, manage_params_from(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(ManageCommand {
        verb: CapabilityVerb(verb.ok_or(DecodeError::MissingField("verb"))?),
        params: params.ok_or(DecodeError::MissingField("params"))?,
    })
}

/// The `$manage-command-params` socket. Typed arms cover core/exec's
/// commands; `Json` is the open catch-all preserving any other domain's
/// params map verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManageParams {
    PtySpawn(PtySpawn),
    PtyWrite(PtyWrite),
    PtyResize(PtyResize),
    PtyKill(PtyKill),
    ProcSpawn(ProcSpawn),
    ProcSignal(ProcSignal),
    ProcKill(ProcKill),
    ExecList(ExecList),
    WebrtcOffer(WebrtcOffer),
    WebrtcAnswer(WebrtcAnswer),
    WebrtcIceCandidate(WebrtcIceCandidate),
    /// An unrecognised command verb: the params map exactly as sent, `* tstr => any`.
    Json(CanonicalMap<String, CborValue>),
}

impl ManageParams {
    /// The inner command verb identifying the params shape.
    pub fn command_verb(&self) -> &str {
        match self {
            ManageParams::PtySpawn(_) => PtySpawn::VERB,
            ManageParams::PtyWrite(_) => PtyWrite::VERB,
            ManageParams::PtyResize(_) => PtyResize::VERB,
            ManageParams::PtyKill(_) => PtyKill::VERB,
            ManageParams::ProcSpawn(_) => ProcSpawn::VERB,
            ManageParams::ProcSignal(_) => ProcSignal::VERB,
            ManageParams::ProcKill(_) => ProcKill::VERB,
            ManageParams::ExecList(_) => ExecList::VERB,
            ManageParams::WebrtcOffer(_) => WebrtcOffer::VERB,
            ManageParams::WebrtcAnswer(_) => WebrtcAnswer::VERB,
            ManageParams::WebrtcIceCandidate(_) => WebrtcIceCandidate::VERB,
            ManageParams::Json(map) => map
                .get(&"verb".to_owned())
                .and_then(|v| match v {
                    CborValue::Text(s) => Some(s.as_str()),
                    _ => None,
                })
                .unwrap_or(""),
        }
    }
}

impl Encode<()> for ManageParams {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        match self {
            ManageParams::PtySpawn(p) => p.encode(e, &mut ()),
            ManageParams::PtyWrite(p) => p.encode(e, &mut ()),
            ManageParams::PtyResize(p) => p.encode(e, &mut ()),
            ManageParams::PtyKill(p) => p.encode(e, &mut ()),
            ManageParams::ProcSpawn(p) => p.encode(e, &mut ()),
            ManageParams::ProcSignal(p) => p.encode(e, &mut ()),
            ManageParams::ProcKill(p) => p.encode(e, &mut ()),
            ManageParams::ExecList(p) => p.encode(e, &mut ()),
            ManageParams::WebrtcOffer(p) => p.encode(e, &mut ()),
            ManageParams::WebrtcAnswer(p) => p.encode(e, &mut ()),
            ManageParams::WebrtcIceCandidate(p) => p.encode(e, &mut ()),
            ManageParams::Json(map) => {
                e.map(map.len() as u64)?;
                for (k, v) in map.iter() {
                    e.str(k)?;
                    v.encode(e, &mut ())?;
                }
                e.ok()
            }
        }
    }
}

impl Decode<'_, ()> for ManageParams {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        manage_params_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn manage_params_from(d: &mut Decoder<'_>) -> Result<ManageParams, DecodeError> {
    // The inner `verb` key identifies the shape, but a CDE-encoded params
    // map need not start with it (a shorter key sorts first — `cwd` and
    // `env` both do). Two passes over the same definite map: find the
    // `verb` literal, rewind, decode through the matching typed arm.
    let start = d.position();
    let mut map = strict::MapDecoder::new(d)?;
    let mut verb: Option<String> = None;
    while let Some(key) = map.next_key(d)? {
        if key == "verb" {
            if verb.is_some() {
                return Err(DecodeError::DuplicateKey);
            }
            verb = Some(strict::text_value(d)?);
        } else {
            d.skip().map_err(DecodeError::from_minicbor)?;
        }
    }
    let verb = verb.ok_or(DecodeError::MissingField("verb"))?;
    d.set_position(start);
    match verb.as_str() {
        PtySpawn::VERB => Ok(ManageParams::PtySpawn(PtySpawn::from_map(d)?)),
        PtyWrite::VERB => Ok(ManageParams::PtyWrite(PtyWrite::from_map(d)?)),
        PtyResize::VERB => Ok(ManageParams::PtyResize(PtyResize::from_map(d)?)),
        PtyKill::VERB => Ok(ManageParams::PtyKill(PtyKill::from_map(d)?)),
        ProcSpawn::VERB => Ok(ManageParams::ProcSpawn(ProcSpawn::from_map(d)?)),
        ProcSignal::VERB => Ok(ManageParams::ProcSignal(ProcSignal::from_map(d)?)),
        ProcKill::VERB => Ok(ManageParams::ProcKill(ProcKill::from_map(d)?)),
        ExecList::VERB => Ok(ManageParams::ExecList(ExecList::from_map(d)?)),
        WebrtcOffer::VERB => Ok(ManageParams::WebrtcOffer(WebrtcOffer::from_map(d)?)),
        WebrtcAnswer::VERB => Ok(ManageParams::WebrtcAnswer(WebrtcAnswer::from_map(d)?)),
        WebrtcIceCandidate::VERB => Ok(ManageParams::WebrtcIceCandidate(
            WebrtcIceCandidate::from_map(d)?,
        )),
        _ => {
            let count = strict::definite_map(d)?;
            let mut map = CanonicalMap::new();
            for _ in 0..count {
                let key = strict::text_key(d)?.to_owned();
                let value = CborValue::decode_strict(d)?;
                map.insert(key, value)?;
            }
            Ok(ManageParams::Json(map))
        }
    }
}

/// `manage-request-frame = { type, request-id, command, scope, ? token }`.
///
/// CDE key order: `type` (5), `scope` (6), `token` (6; bytewise after
/// `scope`), `command` (8), `request-id` (11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManageRequestFrame {
    pub request_id: u64,
    pub command: ManageCommand,
    pub scope: CapabilityScope,
    pub token: Option<CoseSign1>,
}

impl ManageRequestFrame {
    pub const TYPE: &'static str = "manage-request";
}

impl Encode<()> for ManageRequestFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 4 + usize::from(self.token.is_some());
        e.map(len as u64)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("scope")?.encode(&self.scope)?;
        if let Some(token) = &self.token {
            e.str("token")?.encode(token)?;
        }
        e.str("command")?.encode(&self.command)?;
        e.str("request-id")?.u64(self.request_id)?;
        e.ok()
    }
}

impl Decode<'_, ()> for ManageRequestFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        manage_request_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn manage_request_from(d: &mut Decoder<'_>) -> Result<ManageRequestFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut request_id: Option<u64> = None;
    let mut command: Option<ManageCommand> = None;
    let mut scope: Option<CapabilityScope> = None;
    let mut token: Option<CoseSign1> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, ManageRequestFrame::TYPE)?,
            "request-id" => strict::set_once(&mut request_id, strict::uint_value(d)?)?,
            "command" => strict::set_once(&mut command, manage_command_from(d)?)?,
            "scope" => strict::set_once(&mut scope, scope_from(d)?)?,
            "token" => strict::set_once(&mut token, crate::tokens::cose_sign1_from(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(ManageRequestFrame {
        request_id: request_id.ok_or(DecodeError::MissingField("request-id"))?,
        command: command.ok_or(DecodeError::MissingField("command"))?,
        scope: scope.ok_or(DecodeError::MissingField("scope"))?,
        token,
    })
}

/// `manage-ok = { result: "ok", * tstr => any }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ManageOk {
    /// Extension results ride the open tail, e.g. exec.list's `sessions`.
    pub extra: CanonicalMap<String, CborValue>,
}

/// `manage-ok / manage-error`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManageOutcome {
    Ok(ManageOk),
    Error(ManageError),
}

/// `manage-error = { result: "error", code, ? message }`. CDE key order:
/// `code` (5), `result` (7), `message` (8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManageError {
    pub code: String,
    pub message: Option<String>,
}

impl Encode<()> for ManageOutcome {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        match self {
            ManageOutcome::Ok(ok) => {
                // "result" interleaves with the open tail by CDE order, so
                // the literal and the extras must be merged, not
                // concatenated: a 5-character extension key sorts before
                // "result" (7 encoded bytes).
                let mut builder = CdeMapBuilder::new();
                builder.push("result", "ok");
                for (key, value) in ok.extra.iter() {
                    let mut value_buf = Vec::new();
                    let mut value_enc = Encoder::new(&mut value_buf);
                    value
                        .encode(&mut value_enc, &mut ())
                        .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
                    builder.push_raw(key.encoded(), value_buf);
                }
                builder.write(e)
            }
            ManageOutcome::Error(err) => {
                let len = 2 + usize::from(err.message.is_some());
                e.map(len as u64)?;
                e.str("code")?.str(&err.code)?;
                e.str("result")?.str("error")?;
                if let Some(message) = &err.message {
                    e.str("message")?.str(message)?;
                }
                e.ok()
            }
        }
    }
}

impl Decode<'_, ()> for ManageOutcome {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        manage_outcome_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn manage_outcome_from(d: &mut Decoder<'_>) -> Result<ManageOutcome, DecodeError> {
    // `code` and `message` are typed fields of manage-error but ordinary
    // tail extensions of manage-ok (`manage-ok = { result: "ok", * tstr =>
    // any }` admits any key, with any value), so they decode through the
    // open tail here and are pulled out as typed fields only when `result`
    // says "error" -- whose CDDL rule has no open tail at all.
    let mut map = strict::MapDecoder::new(d)?;
    let mut result: Option<String> = None;
    let mut extra = CanonicalMap::new();
    while let Some(key) = map.next_key(d)? {
        match key {
            "result" => strict::set_once(&mut result, strict::text_value(d)?)?,
            other => {
                let value = CborValue::decode_strict(d)?;
                extra.insert(other.to_owned(), value)?;
            }
        }
    }
    match result.as_deref() {
        Some("ok") => Ok(ManageOutcome::Ok(ManageOk { extra })),
        Some("error") => {
            let code = match extra.remove(&"code".to_owned()) {
                Some(CborValue::Text(code)) => code,
                Some(_) => {
                    return Err(DecodeError::Constraint(
                        "manage-error code must be a text string",
                    ))
                }
                None => return Err(DecodeError::MissingField("code")),
            };
            let message = match extra.remove(&"message".to_owned()) {
                Some(CborValue::Text(message)) => Some(message),
                Some(_) => {
                    return Err(DecodeError::Constraint(
                        "manage-error message must be a text string",
                    ))
                }
                None => None,
            };
            if let Some((unknown, _)) = extra.iter().next() {
                return Err(DecodeError::UnknownKey(unknown.clone()));
            }
            Ok(ManageOutcome::Error(ManageError { code, message }))
        }
        Some(other) => Err(DecodeError::BadLiteral {
            expected: "ok | error",
            found: other.to_owned(),
        }),
        None => Err(DecodeError::MissingField("result")),
    }
}

/// `manage-response-frame = { type, request-id, outcome }`. CDE key order:
/// `type` (5), `outcome` (8), `request-id` (11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManageResponseFrame {
    pub request_id: u64,
    pub outcome: ManageOutcome,
}

impl ManageResponseFrame {
    pub const TYPE: &'static str = "manage-response";
}

impl Encode<()> for ManageResponseFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("outcome")?.encode(&self.outcome)?;
        e.str("request-id")?.u64(self.request_id)?;
        e.ok()
    }
}

impl Decode<'_, ()> for ManageResponseFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        manage_response_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn manage_response_from(
    d: &mut Decoder<'_>,
) -> Result<ManageResponseFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut request_id: Option<u64> = None;
    let mut outcome: Option<ManageOutcome> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, ManageResponseFrame::TYPE)?,
            "request-id" => strict::set_once(&mut request_id, strict::uint_value(d)?)?,
            "outcome" => strict::set_once(&mut outcome, manage_outcome_from(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(ManageResponseFrame {
        request_id: request_id.ok_or(DecodeError::MissingField("request-id"))?,
        outcome: outcome.ok_or(DecodeError::MissingField("outcome"))?,
    })
}

/// `revocation-claims = { token-id, issuer, issuer-key, revoked-at }`.
///
/// Self-certifying like token-claims: issuer-key travels inside the signed
/// payload, so a verifier checks `sha256(issuer-key.public-key) == issuer`
/// with no prior contact with the issuer. A bare unsigned
/// `{token-id, revoked-at}` would let any peer falsely announce any other
/// peer's token revoked — the denial-of-service vector the signed shape
/// closes. CDE key order: `issuer` (7), `token-id` (9), `issuer-key` (11),
/// `revoked-at` (11; bytewise after `issuer-key`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevocationClaims {
    pub token_id: Vec<u8>,
    pub issuer: DeviceId,
    pub issuer_key: IdentityKey,
    /// Unix ms.
    pub revoked_at: u64,
}

impl RevocationClaims {
    pub fn decode_bytes(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut d = Decoder::new(bytes);
        let claims = revocation_claims_from(&mut d)?;
        if d.position() != bytes.len() {
            return Err(DecodeError::TrailingBytes {
                consumed: d.position(),
                total: bytes.len(),
            });
        }
        Ok(claims)
    }

    pub fn encode_to_vec(&self) -> Vec<u8> {
        minicbor::to_vec(self).unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"))
    }
}

impl Encode<()> for RevocationClaims {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(4)?;
        e.str("issuer")?.encode(self.issuer)?;
        e.str("token-id")?.bytes(&self.token_id)?;
        e.str("issuer-key")?.encode(&self.issuer_key)?;
        e.str("revoked-at")?.u64(self.revoked_at)?;
        e.ok()
    }
}

impl Decode<'_, ()> for RevocationClaims {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        revocation_claims_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn revocation_claims_from(d: &mut Decoder<'_>) -> Result<RevocationClaims, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut token_id: Option<Vec<u8>> = None;
    let mut issuer: Option<DeviceId> = None;
    let mut issuer_key: Option<IdentityKey> = None;
    let mut revoked_at: Option<u64> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "token-id" => strict::set_once(&mut token_id, strict::bytes_value(d)?)?,
            "issuer" => strict::set_once(&mut issuer, device_id_from(d)?)?,
            "issuer-key" => {
                strict::set_once(&mut issuer_key, crate::identity::identity_key_from(d)?)?
            }
            "revoked-at" => strict::set_once(&mut revoked_at, strict::uint_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(RevocationClaims {
        token_id: token_id.ok_or(DecodeError::MissingField("token-id"))?,
        issuer: issuer.ok_or(DecodeError::MissingField("issuer"))?,
        issuer_key: issuer_key.ok_or(DecodeError::MissingField("issuer-key"))?,
        revoked_at: revoked_at.ok_or(DecodeError::MissingField("revoked-at"))?,
    })
}

/// `revocation-entry = cose-sign1`, `payload = bstr .cbor revocation-claims`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevocationEntry(pub CoseSign1);

impl RevocationEntry {
    /// Parse the signed revocation-claims on demand.
    pub fn decode_claims(&self) -> Result<RevocationClaims, DecodeError> {
        let payload = self
            .0
            .payload
            .as_deref()
            .ok_or(DecodeError::Constraint("revocation-entry payload is nil"))?;
        RevocationClaims::decode_bytes(payload)
    }
}

/// `revocation-announce-frame = { type: "revocation-announce", entries }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RevocationAnnounceFrame {
    pub entries: Vec<RevocationEntry>,
}

impl RevocationAnnounceFrame {
    pub const TYPE: &'static str = "revocation-announce";
}

impl Encode<()> for RevocationAnnounceFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("entries")?.array(self.entries.len() as u64)?;
        for entry in &self.entries {
            e.encode(&entry.0)?;
        }
        e.ok()
    }
}

impl Decode<'_, ()> for RevocationAnnounceFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        revocation_announce_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn revocation_announce_from(
    d: &mut Decoder<'_>,
) -> Result<RevocationAnnounceFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut entries: Option<Vec<RevocationEntry>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, RevocationAnnounceFrame::TYPE)?,
            "entries" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(RevocationEntry(crate::tokens::cose_sign1_from(d)?));
                }
                entries = Some(list);
            }
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(RevocationAnnounceFrame {
        entries: entries.ok_or(DecodeError::MissingField("entries"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manage_ok_accepts_code_and_message_as_ordinary_tail_extensions() {
        // manage-ok's `* tstr => any` admits code/message with any value;
        // they are manage-error's typed fields, not ok's.
        let mut bytes = vec![0xa2, 0x64];
        bytes.extend_from_slice(b"code");
        bytes.push(0x63);
        bytes.extend_from_slice(b"x-y");
        bytes.push(0x66);
        bytes.extend_from_slice(b"result");
        bytes.push(0x62);
        bytes.extend_from_slice(b"ok");
        let mut d = Decoder::new(&bytes);
        let outcome = manage_outcome_from(&mut d).expect("ok outcome with code tail");
        let ManageOutcome::Ok(ok) = &outcome else {
            panic!("expected ok, got {outcome:?}");
        };
        assert_eq!(
            ok.extra.get(&"code".to_owned()),
            Some(&CborValue::Text("x-y".to_owned()))
        );
        // Re-encoding writes the tail back through the CDE builder,
        // byte-identically.
        assert_eq!(&minicbor::to_vec(&outcome).unwrap()[..], &bytes[..]);
    }

    #[test]
    fn manage_error_rejects_unknown_tail_keys() {
        // manage-error has no open tail: with code present, an unrelated
        // key is unknown rather than an accepted extension.
        let mut bytes = vec![0xa3, 0x64];
        bytes.extend_from_slice(b"code");
        bytes.push(0x61);
        bytes.push(b'x');
        bytes.push(0x65);
        bytes.extend_from_slice(b"extra");
        bytes.push(0x01);
        bytes.push(0x66);
        bytes.extend_from_slice(b"result");
        bytes.push(0x65);
        bytes.extend_from_slice(b"error");
        let mut d = Decoder::new(&bytes);
        assert_eq!(
            manage_outcome_from(&mut d),
            Err(DecodeError::UnknownKey("extra".to_owned()))
        );
    }

    fn encode<T>(value: &T) -> T
    where
        T: Encode<()> + PartialEq + core::fmt::Debug + for<'a> Decode<'a, ()>,
    {
        let bytes = minicbor::to_vec(value).expect("encode");
        minicbor::decode(&bytes).expect("decode")
    }

    #[test]
    fn pty_spawn_command_round_trip() {
        let command = ManageCommand {
            verb: CapabilityVerb("exec:pty".to_owned()),
            params: ManageParams::PtySpawn(PtySpawn {
                shell: Some("/bin/sh".to_owned()),
                argv: vec![],
                cwd: Some("/work".to_owned()),
                env: CanonicalMap::new(),
                cols: 80,
                rows: 24,
            }),
        };
        assert_eq!(&encode(&command), &command);
        assert_eq!(command.params.command_verb(), "pty.spawn");
    }

    #[test]
    fn unknown_verb_falls_through_to_json_verbatim() {
        let mut params = CanonicalMap::new();
        params
            .insert("verb".to_owned(), CborValue::Text("future.noun".to_owned()))
            .expect("unique");
        params
            .insert("zebra".to_owned(), CborValue::UInt(1))
            .expect("unique");
        params
            .insert("a".to_owned(), CborValue::Bytes(vec![1]))
            .expect("unique");
        let command = ManageCommand {
            verb: CapabilityVerb("example.com/future:noun".to_owned()),
            params: ManageParams::Json(params),
        };
        assert_eq!(&encode(&command), &command);
        assert_eq!(command.params.command_verb(), "future.noun");
        // Json params re-encode in CDE order ("a" 2 bytes, "verb" 5,
        // "zebra" 6) regardless of insertion order.
        let bytes = minicbor::to_vec(&command.params).expect("encode");
        let a_at = bytes.windows(1).position(|w| w == b"a").expect("a key");
        let verb_at = bytes
            .windows(4)
            .position(|w| w == b"verb")
            .expect("verb key");
        let zebra_at = bytes
            .windows(5)
            .position(|w| w == b"zebra")
            .expect("zebra key");
        assert!(a_at < verb_at && verb_at < zebra_at);
    }

    #[test]
    fn typed_params_reject_unknown_keys() {
        // {"verb": "pty.kill", "session": 1, "bogus": true}
        let bytes: Vec<u8> = [
            0xa3u8, 0x64, b'v', b'e', b'r', b'b', 0x68, b'p', b't', b'y', b'.', b'k', b'i', b'l',
            b'l', 0x67, b's', b'e', b's', b's', b'i', b'o', b'n', 0x01, 0x65, b'b', b'o', b'g',
            b'u', b's', 0xf5,
        ]
        .to_vec();
        assert!(minicbor::decode::<ManageParams>(&bytes).is_err());
    }

    #[test]
    fn manage_ok_merges_result_with_tail_in_cde_order() {
        let mut extra = CanonicalMap::new();
        // A 5-character key encodes to 6 bytes and sorts before "result"
        // (7 encoded bytes): the literal must interleave, not lead.
        extra
            .insert("shots".to_owned(), CborValue::UInt(3))
            .expect("unique");
        let outcome = ManageOutcome::Ok(ManageOk { extra });
        assert_eq!(&encode(&outcome), &outcome);
        let bytes = minicbor::to_vec(&outcome).expect("encode");
        assert_eq!(bytes[0], 0xa2);
        assert_eq!(&bytes[1..3], &[0x65, b's']);
    }

    #[test]
    fn manage_error_outcome_round_trip() {
        let outcome = ManageOutcome::Error(ManageError {
            code: "scope-denied".to_owned(),
            message: Some("token does not authorise this path".to_owned()),
        });
        assert_eq!(&encode(&outcome), &outcome);
        // code, result, message.
        let bytes = minicbor::to_vec(&outcome).expect("encode");
        let code_at = bytes
            .windows(4)
            .position(|w| w == b"code")
            .expect("code key");
        let result_at = bytes
            .windows(6)
            .position(|w| w == b"result")
            .expect("result key");
        let message_at = bytes
            .windows(7)
            .position(|w| w == b"message")
            .expect("message key");
        assert!(code_at < result_at && result_at < message_at);
    }

    #[test]
    fn manage_request_frame_round_trip() {
        let frame = ManageRequestFrame {
            request_id: 1,
            command: ManageCommand {
                verb: CapabilityVerb("exec:pty".to_owned()),
                params: ManageParams::ExecList(ExecList),
            },
            scope: CapabilityScope {
                kind: "folder".to_owned(),
                path: Some("/work".to_owned()),
            },
            token: None,
        };
        assert_eq!(&encode(&frame), &frame);
    }

    #[test]
    fn revocation_claims_cde_order_and_entry_round_trip() {
        let claims = RevocationClaims {
            token_id: vec![1; 16],
            issuer: DeviceId([2; 32]),
            issuer_key: IdentityKey {
                alg: -7,
                public_key: vec![3; 65],
            },
            revoked_at: 42,
        };
        let bytes = claims.encode_to_vec();
        assert_eq!(
            RevocationClaims::decode_bytes(&bytes).expect("decode"),
            claims
        );
        let order: Vec<usize> = ["issuer", "token-id", "issuer-key", "revoked-at"]
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

        let entry = RevocationEntry(CoseSign1 {
            protected: vec![0xa0],
            unprotected: crate::tokens::CoseTokenHeaders::new(),
            payload: Some(bytes),
            signature: vec![0xff; 64],
        });
        let frame = RevocationAnnounceFrame {
            entries: vec![entry.clone(), entry],
        };
        let frame_bytes = minicbor::to_vec(&frame).expect("encode");
        let back: RevocationAnnounceFrame = minicbor::decode(&frame_bytes).expect("decode");
        assert_eq!(back, frame);
        assert_eq!(back.entries[0].decode_claims().expect("claims"), claims);
    }
}
