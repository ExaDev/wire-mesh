//! Domain logic: depends only on the port traits and the wire types, never on an adapter or a global/platform API, so runtime and storage stay swappable composition concerns at the edges.

pub mod cose;
pub mod handshake;
pub mod revocation;
pub mod room;
pub mod room_path;
pub mod room_token_verification;
pub mod tokens;

pub use handshake::{negotiate, NegotiationResult, SUPPORTED_PROTOCOL_VERSION};
pub use revocation::{RevocationError, RevocationView};
pub use room::{compare_room_notices, verify_room_notice, RoomNoticeRejection, RoomNoticeVerdict};
pub use room_path::{device_id_from_hex, device_id_to_hex, parse_room_path, ParsedRoomPath};
pub use room_token_verification::{
    verify_room_token, RoomTokenRejection, RoomTokenVerdict, ROOM_MEMBER_CAPABILITY,
};
pub use tokens::{verify_capability_token, TokenRejection, TokenVerdict};
