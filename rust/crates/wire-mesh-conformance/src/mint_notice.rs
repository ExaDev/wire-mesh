//! The room-notice cases of `mint.v1.json`: `create_room_notice` given fixed inputs must produce exactly the recorded bytes, and the reader must give the recorded verdict on them.

use wire_mesh_core::adapters::NodeIdentity;
use wire_mesh_core::domain::mint::MintError;
use wire_mesh_core::domain::revocation::RevocationView;
use wire_mesh_core::domain::room::{
    create_room_notice, verify_room_notice, NewRoomNotice, RoomNoticeRejection, RoomNoticeVerdict,
};
use wire_mesh_wire::room::MessageRef;
use wire_mesh_wire::tokens::CoseSign1;

use super::mint::FixedClock;
use super::obj::{Check, Obj};
use super::report_first_divergence;

/// One case: the inputs of `create_room_notice`, the vector holding the bytes it must produce and the verdict the owner of the room's reader gives them.
pub(crate) struct NoticeCase {
    pub(crate) name: String,
    pub(crate) poster: String,
    pub(crate) token_vector: String,
    room: String,
    notice_id: Vec<u8>,
    content_type: String,
    content: Vec<u8>,
    refs: Option<Vec<MessageRef>>,
    valid_until: Option<u64>,
    key_epoch: Option<u64>,
    now_ms: u64,
    pub(crate) expected: NoticeExpected,
}

/// What creating the notice must give.
pub(crate) enum NoticeExpected {
    /// The notice of this vector, and the verdict the room owner's reader gives it.
    Created { vector: String, verdict: String },
    /// Creation is refused with this reason, and nothing is signed.
    Refused(String),
}

pub(crate) fn notice_case_of(mut obj: Obj) -> Result<NoticeCase, String> {
    let name = obj.string("name")?;
    let poster = obj.string("poster")?;
    let token_vector = obj.string("token_vector")?;
    let room = obj.string("room")?;
    let notice_id = obj.hex("notice_id_hex")?;
    let content_type = obj.string("content_type")?;
    let content = obj.hex("content_hex")?;
    let refs = obj
        .optional_objects("refs")?
        .map(|refs| {
            refs.into_iter()
                .map(|mut entry| {
                    let parsed = MessageRef {
                        id: entry.hex("id_hex")?,
                        relation: entry.string("relation")?,
                    };
                    entry.finish()?;
                    Ok(parsed)
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?;
    let valid_until = obj.optional_unsigned("valid_until")?;
    let key_epoch = obj.optional_unsigned("key_epoch")?;
    let now_ms = obj.unsigned("now_ms")?;
    let rust_only = obj.boolean("rust_only")?;
    let mut expected_obj = obj.object("expected")?;
    let expected = if expected_obj.map.contains_key("refusal") {
        NoticeExpected::Refused(expected_obj.string("refusal")?)
    } else {
        NoticeExpected::Created {
            vector: expected_obj.string("vector")?,
            verdict: expected_obj.string("verdict")?,
        }
    };
    expected_obj.finish()?;
    obj.finish()?;
    if rust_only != matches!(expected, NoticeExpected::Refused(_)) {
        return Err(format!(
            "case {name} is not flagged rust_only exactly when its creation is refused"
        ));
    }
    Ok(NoticeCase {
        name,
        poster,
        token_vector,
        room,
        notice_id,
        content_type,
        content,
        refs,
        valid_until,
        key_epoch,
        now_ms,
        expected,
    })
}

/// The reader's verdict as the file names it: `valid`, or the snake-case reason of a refusal. Only the refusals a created notice can meet in these cases are named; any other is an error of the file or of the code.
fn verdict_name(verdict: &RoomNoticeVerdict) -> Result<&'static str, String> {
    match verdict {
        RoomNoticeVerdict::Valid { .. } => Ok("valid"),
        RoomNoticeVerdict::Invalid(RoomNoticeRejection::KeyEpochMismatch) => {
            Ok("key_epoch_mismatch")
        }
        RoomNoticeVerdict::Invalid(RoomNoticeRejection::ContentExpired) => Ok("content_expired"),
        RoomNoticeVerdict::Invalid(other) => Err(format!("an unexpected refusal: {other:?}")),
    }
}

/// Creates the notice from the case's inputs. A case that expects a refusal must be refused with that reason. Otherwise the bytes are compared with the vector (`expected_wire`) and `owner` (the root of the poster's token) verifies the notice at the case's clock.
pub(crate) async fn check_notice(
    case: &NoticeCase,
    poster: &NodeIdentity,
    owner: &NodeIdentity,
    token_wire: &[u8],
    expected_wire: Option<&[u8]>,
) -> Check {
    let token = CoseSign1::decode_bytes(token_wire)
        .map_err(|e| format!("the poster's token does not decode: {e}"))?;
    let created = create_room_notice(
        poster,
        &FixedClock(case.now_ms),
        NewRoomNotice {
            room: case.room.clone(),
            token,
            notice_id: case.notice_id.clone(),
            content_type: case.content_type.clone(),
            content: case.content.clone(),
            refs: case.refs.clone(),
            valid_until: case.valid_until,
            key_epoch: case.key_epoch,
        },
    )
    .await;
    let (expected_wire, verdict_wanted) = match (&case.expected, expected_wire) {
        (NoticeExpected::Refused(reason), _) => {
            return match created {
                Err(MintError::Refused(refusal)) if refusal.as_str() == reason => Ok(()),
                Err(other) => Err(format!("expected the refusal {reason}, got {other}")),
                Ok(_) => Err(format!(
                    "expected the refusal {reason}, but a notice was created"
                )),
            };
        }
        (NoticeExpected::Created { verdict, .. }, Some(wire)) => (wire, verdict),
        (NoticeExpected::Created { .. }, None) => {
            return Err("a created case has no vector wire".to_owned())
        }
    };
    let notice = created.map_err(|e| format!("create_room_notice: {e}"))?;
    report_first_divergence(expected_wire, &notice.encode_to_vec())?;
    let verdict = verify_room_notice(
        owner,
        &FixedClock(case.now_ms),
        &RevocationView::new(),
        &notice,
        None,
    )
    .await;
    let name = verdict_name(&verdict)?;
    if name == verdict_wanted {
        Ok(())
    } else {
        Err(format!("expected the verdict {verdict_wanted}, got {name}"))
    }
}
