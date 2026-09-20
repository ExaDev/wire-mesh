//! Domain logic: depends only on the port traits and the wire types, never on an adapter or a global/platform API, so runtime and storage stay swappable composition concerns at the edges.

pub mod cose;
pub mod erasure_coding;
pub mod group_key;
pub mod handshake;
pub mod peer_advert;
pub mod predicates;
pub mod revocation;
pub mod room;
pub mod room_path;
pub mod room_token_verification;
#[cfg(feature = "net")]
pub mod session;
pub mod shard_manifest;
pub mod tokens;

pub use handshake::{negotiate, NegotiationResult, SUPPORTED_PROTOCOL_VERSION};
pub use peer_advert::{
    sign_peer_advert, verify_peer_advert, PeerAdvertRejection, PeerAdvertVerdict,
};
pub use revocation::{RevocationError, RevocationView};
pub use room::{compare_room_notices, verify_room_notice, RoomNoticeRejection, RoomNoticeVerdict};
pub use room_path::{device_id_from_hex, device_id_to_hex, parse_room_path, ParsedRoomPath};
pub use room_token_verification::{
    verify_room_token, RoomTokenRejection, RoomTokenVerdict, ROOM_MEMBER_CAPABILITY,
};
#[cfg(feature = "net")]
pub use session::{
    DataFrame, HandlerRegistry, IncomingManageRequest, ManageRequestHandler, Session, SessionEvent,
};
pub use tokens::{verify_capability_token, TokenRejection, TokenVerdict};
