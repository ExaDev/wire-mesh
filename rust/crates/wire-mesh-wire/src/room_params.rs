//! The typed core/room and capability verbs: the `$manage-command-params` members `room.send`, `room.read`, `room.leave`, `room.invite` and `capability.request` (`spec/room.cddl`, `spec/management.cddl`) and the typed `manage-ok` shapes `room-join-ok`, `room-members-ok` and `capability-grant-ok`.
//!
//! Every one of these CDDL rules ends in the open tail `* tstr => any`, so each type carries an `extra` map holding the keys it does not name, in the order the encoder merges them, and a decode followed by an encode reproduces the bytes exactly. A key the rule names is checked against its type and is never carried in `extra`.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::identity::{device_id_from, DeviceId};
use crate::management::{ManageOk, ManageOutcome};
use crate::open_tail::{ok_conversions, params_codec, push_extra, read_ok, read_params, Extra};
use crate::room::MessageRef;
use crate::strict;
use crate::tokens::{cose_sign1_from, CoseSign1};
use crate::value::{CborValue, CdeKey, CdeMapBuilder};

fn message_refs_from(d: &mut Decoder<'_>) -> Result<Vec<MessageRef>, DecodeError> {
    let count = strict::definite_array(d)?;
    let mut list = Vec::new();
    for _ in 0..count {
        list.push(
            d.decode::<MessageRef>()
                .map_err(DecodeError::from_minicbor)?,
        );
    }
    Ok(list)
}

fn bytes_array_from(d: &mut Decoder<'_>) -> Result<Vec<Vec<u8>>, DecodeError> {
    let count = strict::definite_array(d)?;
    let mut list = Vec::new();
    for _ in 0..count {
        list.push(strict::bytes_value(d)?);
    }
    Ok(list)
}

/// `room-send = { verb: "room.send", "message-id": bstr, "sent-at": uint, text: tstr, ? "content-type": tstr, ? refs: [* message-ref], * tstr => any }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomSend {
    pub message_id: Vec<u8>,
    pub sent_at: u64,
    pub text: String,
    pub content_type: Option<String>,
    pub refs: Option<Vec<MessageRef>>,
    pub extra: Extra,
}

impl RoomSend {
    pub const VERB: &'static str = "room.send";

    fn build(&self) -> CdeMapBuilder {
        let mut builder = CdeMapBuilder::new();
        builder.push("verb", Self::VERB);
        builder.push_bytes("message-id", &self.message_id);
        builder.push("sent-at", &self.sent_at);
        builder.push("text", &self.text);
        if let Some(content_type) = &self.content_type {
            builder.push("content-type", content_type);
        }
        if let Some(refs) = &self.refs {
            let mut buf = Vec::new();
            let mut enc = Encoder::new(&mut buf);
            enc.array(refs.len() as u64)
                .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
            for reference in refs {
                reference
                    .encode(&mut enc, &mut ())
                    .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
            }
            builder.push_raw("refs".encoded(), buf);
        }
        push_extra(&mut builder, &self.extra);
        builder
    }

    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut message_id = None;
        let mut sent_at = None;
        let mut text = None;
        let mut content_type = None;
        let mut refs = None;
        let extra = read_params(d, Self::VERB, &mut |d, key| {
            match key {
                "message-id" => strict::set_once(&mut message_id, strict::bytes_value(d)?)?,
                "sent-at" => strict::set_once(&mut sent_at, strict::exact_uint_value(d)?)?,
                "text" => strict::set_once(&mut text, strict::text_value(d)?)?,
                "content-type" => strict::set_once(&mut content_type, strict::text_value(d)?)?,
                "refs" => strict::set_once(&mut refs, message_refs_from(d)?)?,
                _ => return Ok(false),
            }
            Ok(true)
        })?;
        Ok(RoomSend {
            message_id: message_id.ok_or(DecodeError::MissingField("message-id"))?,
            sent_at: sent_at.ok_or(DecodeError::MissingField("sent-at"))?,
            text: text.ok_or(DecodeError::MissingField("text"))?,
            content_type,
            refs,
            extra,
        })
    }
}

params_codec!(RoomSend);

/// `room-read = { verb: "room.read", messages: [* bstr], at: uint, * tstr => any }`. That `messages` is non-empty is a verifier obligation of the domain, not a constraint of the codec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomRead {
    pub messages: Vec<Vec<u8>>,
    pub at: u64,
    pub extra: Extra,
}

impl RoomRead {
    pub const VERB: &'static str = "room.read";

    fn build(&self) -> CdeMapBuilder {
        let mut builder = CdeMapBuilder::new();
        builder.push("verb", Self::VERB);
        let mut buf = Vec::new();
        let mut enc = Encoder::new(&mut buf);
        enc.array(self.messages.len() as u64)
            .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
        for message in &self.messages {
            enc.bytes(message)
                .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
        }
        builder.push_raw("messages".encoded(), buf);
        builder.push("at", &self.at);
        push_extra(&mut builder, &self.extra);
        builder
    }

    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut messages = None;
        let mut at = None;
        let extra = read_params(d, Self::VERB, &mut |d, key| {
            match key {
                "messages" => strict::set_once(&mut messages, bytes_array_from(d)?)?,
                "at" => strict::set_once(&mut at, strict::exact_uint_value(d)?)?,
                _ => return Ok(false),
            }
            Ok(true)
        })?;
        Ok(RoomRead {
            messages: messages.ok_or(DecodeError::MissingField("messages"))?,
            at: at.ok_or(DecodeError::MissingField("at"))?,
            extra,
        })
    }
}

params_codec!(RoomRead);

/// `room-leave = { verb: "room.leave", * tstr => any }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RoomLeave {
    pub extra: Extra,
}

impl RoomLeave {
    pub const VERB: &'static str = "room.leave";

    fn build(&self) -> CdeMapBuilder {
        let mut builder = CdeMapBuilder::new();
        builder.push("verb", Self::VERB);
        push_extra(&mut builder, &self.extra);
        builder
    }

    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let extra = read_params(d, Self::VERB, &mut |_, _| Ok(false))?;
        Ok(RoomLeave { extra })
    }
}

params_codec!(RoomLeave);

/// `room-invite = { verb: "room.invite", invitee: device-id, token: capability-token, * tstr => any }`: the owner's unprompted push of a freshly minted `room:member` grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomInvite {
    pub invitee: DeviceId,
    pub token: CoseSign1,
    pub extra: Extra,
}

impl RoomInvite {
    pub const VERB: &'static str = "room.invite";

    fn build(&self) -> CdeMapBuilder {
        let mut builder = CdeMapBuilder::new();
        builder.push("verb", Self::VERB);
        builder.push("invitee", &self.invitee);
        builder.push("token", &self.token);
        push_extra(&mut builder, &self.extra);
        builder
    }

    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut invitee = None;
        let mut token = None;
        let extra = read_params(d, Self::VERB, &mut |d, key| {
            match key {
                "invitee" => strict::set_once(&mut invitee, device_id_from(d)?)?,
                "token" => strict::set_once(&mut token, cose_sign1_from(d)?)?,
                _ => return Ok(false),
            }
            Ok(true)
        })?;
        Ok(RoomInvite {
            invitee: invitee.ok_or(DecodeError::MissingField("invitee"))?,
            token: token.ok_or(DecodeError::MissingField("token"))?,
            extra,
        })
    }
}

params_codec!(RoomInvite);

/// `capability-request = { verb: "capability.request", capability: tstr, ? valid-until: uint, * tstr => any }`. The outer `manage-command.verb` of such a request is the capability string itself, which the codec does not check: it is a routing rule of the receiver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityRequest {
    pub capability: String,
    pub valid_until: Option<u64>,
    pub extra: Extra,
}

impl CapabilityRequest {
    pub const VERB: &'static str = "capability.request";

    fn build(&self) -> CdeMapBuilder {
        let mut builder = CdeMapBuilder::new();
        builder.push("verb", Self::VERB);
        builder.push("capability", &self.capability);
        if let Some(valid_until) = self.valid_until {
            builder.push("valid-until", &valid_until);
        }
        push_extra(&mut builder, &self.extra);
        builder
    }

    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut capability = None;
        let mut valid_until = None;
        let extra = read_params(d, Self::VERB, &mut |d, key| {
            match key {
                "capability" => strict::set_once(&mut capability, strict::text_value(d)?)?,
                "valid-until" => strict::set_once(&mut valid_until, strict::exact_uint_value(d)?)?,
                _ => return Ok(false),
            }
            Ok(true)
        })?;
        Ok(CapabilityRequest {
            capability: capability.ok_or(DecodeError::MissingField("capability"))?,
            valid_until,
            extra,
        })
    }
}

params_codec!(CapabilityRequest);

/// `room-member = { device: device-id, * tstr => any }`: one member of a membership list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomMember {
    pub device: DeviceId,
    pub extra: Extra,
}

impl Encode<()> for RoomMember {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let mut builder = CdeMapBuilder::new();
        builder.push("device", &self.device);
        push_extra(&mut builder, &self.extra);
        builder.write(e)
    }
}

fn room_member_from(d: &mut Decoder<'_>) -> Result<RoomMember, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut device = None;
    let mut extra = Extra::new();
    while let Some(key) = map.next_key(d)? {
        if key == "device" {
            strict::set_once(&mut device, device_id_from(d)?)?;
        } else {
            let value = CborValue::decode_strict(d)?;
            extra.insert(key.to_owned(), value)?;
        }
    }
    Ok(RoomMember {
        device: device.ok_or(DecodeError::MissingField("device"))?,
        extra,
    })
}

impl Decode<'_, ()> for RoomMember {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        room_member_from(d).map_err(minicbor::decode::Error::custom)
    }
}

fn members_from(d: &mut Decoder<'_>) -> Result<Vec<RoomMember>, DecodeError> {
    let count = strict::definite_array(d)?;
    let mut members = Vec::new();
    for _ in 0..count {
        members.push(room_member_from(d)?);
    }
    Ok(members)
}

fn push_members(builder: &mut CdeMapBuilder, members: &[RoomMember]) {
    let mut buf = Vec::new();
    let mut enc = Encoder::new(&mut buf);
    enc.array(members.len() as u64)
        .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
    for member in members {
        member
            .encode(&mut enc, &mut ())
            .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
    }
    builder.push_raw("members".encoded(), buf);
}

/// `room-join-ok = { result: "ok", "granted-token": capability-token, members: [* room-member], * tstr => any }`: the owner's answer to an approved `room.join`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomJoinOk {
    pub granted_token: CoseSign1,
    pub members: Vec<RoomMember>,
    pub extra: Extra,
}

impl RoomJoinOk {
    fn build(&self) -> CdeMapBuilder {
        let mut builder = CdeMapBuilder::new();
        builder.push("result", "ok");
        builder.push("granted-token", &self.granted_token);
        push_members(&mut builder, &self.members);
        push_extra(&mut builder, &self.extra);
        builder
    }

    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut granted_token = None;
        let mut members = None;
        let extra = read_ok(d, &mut |d, key| {
            match key {
                "granted-token" => strict::set_once(&mut granted_token, cose_sign1_from(d)?)?,
                "members" => strict::set_once(&mut members, members_from(d)?)?,
                _ => return Ok(false),
            }
            Ok(true)
        })?;
        Ok(RoomJoinOk {
            granted_token: granted_token.ok_or(DecodeError::MissingField("granted-token"))?,
            members: members.ok_or(DecodeError::MissingField("members"))?,
            extra,
        })
    }
}

params_codec!(RoomJoinOk);

/// `room-members-ok = { result: "ok", members: [* room-member], * tstr => any }`: the answer to `room.members`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomMembersOk {
    pub members: Vec<RoomMember>,
    pub extra: Extra,
}

impl RoomMembersOk {
    fn build(&self) -> CdeMapBuilder {
        let mut builder = CdeMapBuilder::new();
        builder.push("result", "ok");
        push_members(&mut builder, &self.members);
        push_extra(&mut builder, &self.extra);
        builder
    }

    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut members = None;
        let extra = read_ok(d, &mut |d, key| {
            match key {
                "members" => strict::set_once(&mut members, members_from(d)?)?,
                _ => return Ok(false),
            }
            Ok(true)
        })?;
        Ok(RoomMembersOk {
            members: members.ok_or(DecodeError::MissingField("members"))?,
            extra,
        })
    }
}

params_codec!(RoomMembersOk);

/// `capability-grant-ok = { result: "ok", "granted-token": capability-token, * tstr => any }`: the answer to an approved `capability.request`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityGrantOk {
    pub granted_token: CoseSign1,
    pub extra: Extra,
}

impl CapabilityGrantOk {
    fn build(&self) -> CdeMapBuilder {
        let mut builder = CdeMapBuilder::new();
        builder.push("result", "ok");
        builder.push("granted-token", &self.granted_token);
        push_extra(&mut builder, &self.extra);
        builder
    }

    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut granted_token = None;
        let extra = read_ok(d, &mut |d, key| {
            match key {
                "granted-token" => strict::set_once(&mut granted_token, cose_sign1_from(d)?)?,
                _ => return Ok(false),
            }
            Ok(true)
        })?;
        Ok(CapabilityGrantOk {
            granted_token: granted_token.ok_or(DecodeError::MissingField("granted-token"))?,
            extra,
        })
    }
}

params_codec!(CapabilityGrantOk);

ok_conversions!(RoomJoinOk);
ok_conversions!(RoomMembersOk);
ok_conversions!(CapabilityGrantOk);
