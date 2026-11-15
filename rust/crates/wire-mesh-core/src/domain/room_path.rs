//! Room paths: the naming and parsing convention core/room's device-keyed membership uses, mirroring `room.cddl`'s `owner-named-room-path` and `dm-room-path` grammar exactly. An owner-named room is `<owner-hex>/<local-name>`, trust rooted at the owner named in the path. A DM is the bytewise-ascending sorted pair `<lower-hex>+<higher-hex>`, trust rooted at the verifier itself rather than either named party. Ported from `room-path.ts`, with the hex codec the paths are built from.

use wire_mesh_wire::identity::DeviceId;

const DEVICE_ID_BYTE_LENGTH: usize = 32;
const DEVICE_ID_HEX_LENGTH: usize = DEVICE_ID_BYTE_LENGTH * 2;

/// Lowercase, byte-exact hex of any byte string: two digits per byte, the text form every device-id, token-id and room-path component takes.
#[must_use]
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The reverse of [`bytes_to_hex`]: `None` for an odd-length string, a character that is not a lowercase hex digit or an uppercase letter, rather than silently truncating or normalising a malformed input.
#[must_use]
pub fn bytes_from_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 == 1
        || !hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

/// Lowercase, byte-exact hex: the same encoding `room.cddl`'s `device-id-hex` regex and the conformance vectors' synthetic device-ids already use.
#[must_use]
pub fn device_id_to_hex(device: &DeviceId) -> String {
    bytes_to_hex(&device.0)
}

/// Parses a lowercase, 64-character device-id-hex string back into the
/// 32-byte `DeviceId` it encodes. Returns `None` for anything that isn't
/// exactly that shape, rather than silently truncating or zero-padding a
/// malformed input.
pub fn device_id_from_hex(hex: &str) -> Option<DeviceId> {
    if hex.len() != DEVICE_ID_HEX_LENGTH {
        return None;
    }
    let bytes: [u8; DEVICE_ID_BYTE_LENGTH] = bytes_from_hex(hex)?.try_into().ok()?;
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

/// Why a string is not a room path, or a name or device-id is not usable in one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoomPathError {
    /// A device-id given as hex is not 64 lowercase hex characters.
    NotDeviceIdHex,
    /// A local name is empty or has a character outside `[A-Za-z0-9_-]`.
    NotLocalName,
    /// A DM names the same device twice.
    SameDevice,
    /// The string matches neither the owner-named nor the DM shape.
    NotARoomPath,
    /// A name has no character of `[A-Za-z0-9_-]` to make a local name of.
    NothingToSlug,
}

impl RoomPathError {
    /// Every error, so a test can require that each has a case.
    pub const ALL: [RoomPathError; 5] = [
        RoomPathError::NotDeviceIdHex,
        RoomPathError::NotLocalName,
        RoomPathError::SameDevice,
        RoomPathError::NotARoomPath,
        RoomPathError::NothingToSlug,
    ];

    /// The name the conformance vectors use for this error.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            RoomPathError::NotDeviceIdHex => "not_device_id_hex",
            RoomPathError::NotLocalName => "not_local_name",
            RoomPathError::SameDevice => "same_device",
            RoomPathError::NotARoomPath => "not_a_room_path",
            RoomPathError::NothingToSlug => "nothing_to_slug",
        }
    }
}

impl std::fmt::Display for RoomPathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            RoomPathError::NotDeviceIdHex => "not a 64-character lowercase hex device-id",
            RoomPathError::NotLocalName => "not a local name of [A-Za-z0-9_-]+",
            RoomPathError::SameDevice => "a DM cannot name the same device twice",
            RoomPathError::NotARoomPath => "not a valid room path",
            RoomPathError::NothingToSlug => "no valid room-name characters to slug",
        })
    }
}

impl std::error::Error for RoomPathError {}

/// A string known to be a valid room path: owner-named or DM. It can only be made by [`RoomPath::new`] (which parses), [`owner_named_room_path`] or [`dm_room_path`], so holding one is the proof.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RoomPath(String);

impl RoomPath {
    /// Checks `path` against the grammar.
    ///
    /// # Errors
    ///
    /// [`RoomPathError::NotARoomPath`] when it matches neither shape.
    pub fn new(path: impl Into<String>) -> Result<Self, RoomPathError> {
        let path = path.into();
        parse_room_path(&path).ok_or(RoomPathError::NotARoomPath)?;
        Ok(RoomPath(path))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The path taken apart.
    #[must_use]
    pub fn parsed(&self) -> ParsedRoomPath {
        parse_room_path(&self.0).unwrap_or_else(|| unreachable!("a RoomPath is a valid path"))
    }
}

impl std::fmt::Display for RoomPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// `<owner-hex>/<local-name>`. `local_name` must already satisfy `[A-Za-z0-9_-]+`: run an untrusted name through [`slug_room_name`] first.
///
/// # Errors
///
/// [`RoomPathError::NotDeviceIdHex`] when `owner` is not a device-id in hex (checked first), [`RoomPathError::NotLocalName`] when `local_name` is not a local name.
pub fn owner_named_room_path(owner: &str, local_name: &str) -> Result<RoomPath, RoomPathError> {
    if !is_device_id_hex(owner) {
        return Err(RoomPathError::NotDeviceIdHex);
    }
    if !is_local_name(local_name) {
        return Err(RoomPathError::NotLocalName);
    }
    Ok(RoomPath(format!("{owner}/{local_name}")))
}

/// `<lower-hex>+<higher-hex>`, the bytewise-ascending sorted pair. A path naming the same device twice is not a valid DM path at all, so `a == b` is refused: a self-DM is a purely local concept a consumer models its own way.
///
/// # Errors
///
/// [`RoomPathError::NotDeviceIdHex`] when `a` or `b` is not a device-id in hex (`a` first), [`RoomPathError::SameDevice`] when they are equal.
pub fn dm_room_path(a: &str, b: &str) -> Result<RoomPath, RoomPathError> {
    if !is_device_id_hex(a) || !is_device_id_hex(b) {
        return Err(RoomPathError::NotDeviceIdHex);
    }
    match a.cmp(b) {
        std::cmp::Ordering::Equal => Err(RoomPathError::SameDevice),
        std::cmp::Ordering::Less => Ok(RoomPath(format!("{a}+{b}"))),
        std::cmp::Ordering::Greater => Ok(RoomPath(format!("{b}+{a}"))),
    }
}

/// Sanitises an arbitrary name (a directory name, say) into a valid local name: every run of characters outside `[A-Za-z0-9_-]` becomes one hyphen, and hyphens at either end are trimmed.
///
/// # Errors
///
/// [`RoomPathError::NothingToSlug`] when nothing valid remains.
pub fn slug_room_name(name: &str) -> Result<String, RoomPathError> {
    let mut slug = String::with_capacity(name.len());
    let mut in_invalid_run = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            slug.push(ch);
            in_invalid_run = false;
        } else if !in_invalid_run {
            slug.push('-');
            in_invalid_run = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        return Err(RoomPathError::NothingToSlug);
    }
    Ok(slug.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The grammar's edges for the room-path and device-id-hex patterns: the
    /// empty string, spaces, a trailing newline, NUL, non-ASCII, uppercase hex,
    /// a wrong length and an extra separator.
    #[test]
    fn room_path_and_device_id_edges_match_the_grammar() {
        let hex = "ab".repeat(32);
        for path in [
            String::new(),
            format!(" {hex}/general"),
            format!("{hex}/general "),
            format!("{hex}/general\n"),
            format!("{hex}/general\0"),
            format!("{hex}/gen\u{e9}ral"),
            format!("{hex}/general/more"),
            format!("{hex}/"),
            format!("{}/general", hex.to_uppercase()),
            format!("0{hex}/general"),
            format!("{hex}0/general"),
            format!("{hex}+{hex}\n"),
            format!("{hex}+{hex}0"),
            format!("0{hex}+{hex}"),
            format!("{hex}+{hex}+{hex}"),
            format!("{hex}+"),
        ] {
            assert_eq!(parse_room_path(&path), None, "{path:?}");
        }
        for device in [
            String::new(),
            format!("{hex}\n"),
            format!("{hex}0"),
            format!("0{hex}"),
            format!(" {hex}"),
            hex.to_uppercase(),
            format!("{}\0", &hex[..63]),
            "\u{e9}".repeat(32),
        ] {
            assert_eq!(device_id_from_hex(&device), None, "{device:?}");
        }
    }

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
