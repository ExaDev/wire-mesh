//! Room paths -- the naming and parsing convention core/room's device-keyed
//! membership uses, mirroring `room.cddl`'s own
//! `owner-named-room-path`/`dm-room-path` grammar exactly: an owner-named
//! room is `<owner-hex>/<local-name>`, trust rooted at the owner named in
//! the path; a DM is the bytewise-ascending sorted pair
//! `<lower-hex>+<higher-hex>`, trust rooted at the verifier itself rather
//! than either named party. Ported from `room-path.ts` -- verification-side
//! only (parsing and the hex codec it needs), since minting/slugifying a
//! room path is not something `verify_room_token` itself needs.

use wire_mesh_wire::identity::DeviceId;

const DEVICE_ID_BYTE_LENGTH: usize = 32;
const DEVICE_ID_HEX_LENGTH: usize = DEVICE_ID_BYTE_LENGTH * 2;

/// Lowercase, byte-exact hex -- the same encoding `room.cddl`'s
/// `device-id-hex` regex and the conformance vectors' synthetic
/// device-ids already use.
pub fn device_id_to_hex(device: &DeviceId) -> String {
    let mut out = String::with_capacity(DEVICE_ID_HEX_LENGTH);
    for byte in device.0 {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Parses a lowercase, 64-character device-id-hex string back into the
/// 32-byte `DeviceId` it encodes. Returns `None` for anything that isn't
/// exactly that shape, rather than silently truncating or zero-padding a
/// malformed input.
pub fn device_id_from_hex(hex: &str) -> Option<DeviceId> {
    if hex.len() != DEVICE_ID_HEX_LENGTH {
        return None;
    }
    if !hex
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut bytes = [0u8; DEVICE_ID_BYTE_LENGTH];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(DeviceId(bytes))
}

fn is_device_id_hex(s: &str) -> bool {
    s.len() == DEVICE_ID_HEX_LENGTH
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_local_name(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedRoomPath {
    OwnerNamed { owner: String, local_name: String },
    Dm { participants: (String, String) },
}

/// Parses a room-path back into its owner-named or DM shape. Returns
/// `None` for anything matching neither -- there is no third path shape.
pub fn parse_room_path(path: &str) -> Option<ParsedRoomPath> {
    if let Some(slash_index) = path.find('/') {
        let owner = &path[..slash_index];
        let local_name = &path[slash_index + 1..];
        if is_device_id_hex(owner) && is_local_name(local_name) {
            return Some(ParsedRoomPath::OwnerNamed {
                owner: owner.to_owned(),
                local_name: local_name.to_owned(),
            });
        }
    }
    if let Some(plus_index) = path.find('+') {
        let first = &path[..plus_index];
        let second = &path[plus_index + 1..];
        if is_device_id_hex(first) && is_device_id_hex(second) && first != second {
            return Some(ParsedRoomPath::Dm {
                participants: (first.to_owned(), second.to_owned()),
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_hex_round_trips() {
        let device = DeviceId([0xAB; 32]);
        let hex = device_id_to_hex(&device);
        assert_eq!(hex, "ab".repeat(32));
        assert_eq!(device_id_from_hex(&hex), Some(device));
    }

    #[test]
    fn device_id_from_hex_rejects_wrong_length() {
        assert_eq!(device_id_from_hex("ab"), None);
        assert_eq!(device_id_from_hex(&"ab".repeat(33)), None);
    }

    #[test]
    fn device_id_from_hex_rejects_uppercase() {
        assert_eq!(device_id_from_hex(&"AB".repeat(32)), None);
    }

    #[test]
    fn device_id_from_hex_rejects_non_hex_characters() {
        assert_eq!(device_id_from_hex(&"zz".repeat(32)), None);
    }

    #[test]
    fn parses_an_owner_named_room_path() {
        let owner = "11".repeat(32);
        let path = format!("{owner}/general");
        assert_eq!(
            parse_room_path(&path),
            Some(ParsedRoomPath::OwnerNamed {
                owner: owner.clone(),
                local_name: "general".to_owned(),
            })
        );
    }

    #[test]
    fn parses_a_dm_room_path() {
        let a = "11".repeat(32);
        let b = "22".repeat(32);
        let path = format!("{a}+{b}");
        assert_eq!(
            parse_room_path(&path),
            Some(ParsedRoomPath::Dm {
                participants: (a.clone(), b.clone()),
            })
        );
    }

    #[test]
    fn refuses_a_dm_path_naming_the_same_device_twice() {
        let a = "11".repeat(32);
        let path = format!("{a}+{a}");
        assert_eq!(parse_room_path(&path), None);
    }

    #[test]
    fn refuses_a_path_matching_neither_shape() {
        assert_eq!(parse_room_path("not-a-room-path"), None);
        assert_eq!(parse_room_path(""), None);
    }

    #[test]
    fn refuses_an_owner_named_path_whose_owner_is_not_valid_hex() {
        assert_eq!(parse_room_path("not-hex/general"), None);
    }

    #[test]
    fn refuses_a_local_name_containing_a_slash() {
        // "<hex>/sub/path" -- the first slash splits owner correctly, but the local name itself then contains an invalid "/" character.
        let owner = "11".repeat(32);
        let path = format!("{owner}/sub/path");
        assert_eq!(parse_room_path(&path), None);
    }
}
