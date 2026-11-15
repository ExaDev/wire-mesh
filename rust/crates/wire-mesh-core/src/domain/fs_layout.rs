//! The layout of a file-backed key-value store, as plain functions that do no I/O: a key maps to a relative path, a relative path maps back to its key, and a value is the whole content of its file.
//!
//! It is the layout the TypeScript `createNodeFsStorage` writes, so a directory written by either implementation is read by the other, and a consumer that keeps a store in memory and does its own file reads and writes uses the same layout as [`crate::adapters::FsStorage`].
//!
//! A key that `path.join` would rewrite (empty, `.` and `..` segments, a doubled or trailing separator) or that leaves the directory would be stored under a name other than its own and come back from a listing as a different key, so the layout refuses it, as the TypeScript `createNodeFsStorage` does. So is a segment that starts with an ASCII letter and a colon, which Windows reads as a drive prefix that replaces the store's directory when joined onto it (`C:/x`) or names the drive's current directory (`C:x`). The refusals are the same on every host: `/` is the only separator, and a backslash is refused so that the layout does not depend on the operating system. Names that only some filesystems rewrite (Windows alternate data streams, trailing dots or spaces, reserved device names, case folding, Unicode normalisation) are not covered, and containment is lexical, so a symlink inside the directory is still followed.

use std::path::{Component, Path, PathBuf};

/// Why a key is not a key of the layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyRefusal {
    /// The empty key names the directory itself, not a file in it.
    Empty,
    /// A NUL byte cannot occur in a file name.
    Nul,
    /// A backslash is a separator on some hosts and an ordinary character on others.
    Backslash,
    /// A leading `/` would name a path outside the directory.
    Absolute,
    /// An empty segment: a doubled `/`, or a trailing one.
    EmptySegment,
    /// A `.` segment, which `path.join` removes.
    DotSegment,
    /// A `..` segment, which `path.join` resolves and which can leave the directory.
    ParentSegment,
    /// A segment that starts with an ASCII letter and a colon, which Windows reads as a drive prefix: joined onto the store's directory it replaces the directory (`C:/x`) or names the drive's current directory (`C:x`).
    DrivePrefix,
}

impl KeyRefusal {
    /// Every refusal, so a test can require that each has a case.
    pub const ALL: [KeyRefusal; 8] = [
        KeyRefusal::Empty,
        KeyRefusal::Nul,
        KeyRefusal::Backslash,
        KeyRefusal::Absolute,
        KeyRefusal::EmptySegment,
        KeyRefusal::DotSegment,
        KeyRefusal::ParentSegment,
        KeyRefusal::DrivePrefix,
    ];

    /// The name the conformance vectors use for this refusal.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            KeyRefusal::Empty => "empty",
            KeyRefusal::Nul => "nul",
            KeyRefusal::Backslash => "backslash",
            KeyRefusal::Absolute => "absolute",
            KeyRefusal::EmptySegment => "empty_segment",
            KeyRefusal::DotSegment => "dot_segment",
            KeyRefusal::ParentSegment => "parent_segment",
            KeyRefusal::DrivePrefix => "drive_prefix",
        }
    }
}

impl std::fmt::Display for KeyRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            KeyRefusal::Empty => "the key is empty",
            KeyRefusal::Nul => "the key contains a NUL",
            KeyRefusal::Backslash => "the key contains a backslash",
            KeyRefusal::Absolute => "the key starts with a slash",
            KeyRefusal::EmptySegment => "the key has an empty segment",
            KeyRefusal::DotSegment => "the key has a \".\" segment",
            KeyRefusal::ParentSegment => "the key has a \"..\" segment",
            KeyRefusal::DrivePrefix => "the key has a segment that starts like a drive prefix",
        })
    }
}

impl std::error::Error for KeyRefusal {}

/// Whether `segment` starts with an ASCII letter and a colon, the form Windows reads as a drive.
fn starts_like_a_drive(segment: &str) -> bool {
    matches!(segment.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic())
}

/// Checks `key` against the layout. The first rule it breaks is the refusal, taken in this order: empty, NUL, backslash, a leading slash, then each segment from the left (empty, `.`, `..`, a drive prefix: an ASCII letter followed by a colon).
///
/// # Errors
///
/// The [`KeyRefusal`] of the first rule the key breaks.
pub fn check_key(key: &str) -> Result<(), KeyRefusal> {
    if key.is_empty() {
        return Err(KeyRefusal::Empty);
    }
    if key.contains('\0') {
        return Err(KeyRefusal::Nul);
    }
    if key.contains('\\') {
        return Err(KeyRefusal::Backslash);
    }
    if key.starts_with('/') {
        return Err(KeyRefusal::Absolute);
    }
    for segment in key.split('/') {
        match segment {
            "" => return Err(KeyRefusal::EmptySegment),
            "." => return Err(KeyRefusal::DotSegment),
            ".." => return Err(KeyRefusal::ParentSegment),
            _ if starts_like_a_drive(segment) => return Err(KeyRefusal::DrivePrefix),
            _ => {}
        }
    }
    Ok(())
}

/// The path of the file holding `key`, relative to the store's directory: one component per segment of the key, so the same key is the same path on every host.
///
/// # Errors
///
/// The [`KeyRefusal`] of a key that is not a key of the layout.
pub fn key_to_relative_path(key: &str) -> Result<PathBuf, KeyRefusal> {
    check_key(key)?;
    Ok(key.split('/').collect())
}

/// Why a relative path is not the path of a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathRefusal {
    /// The path is absolute, or has a prefix or a root.
    NotRelative,
    /// A component is `.` or `..`, which no file of a store has.
    NotNormal,
    /// A component is not valid UTF-8, so no key names it.
    NotUtf8,
    /// The path spells a string that is not a key of the layout, for example a file whose name has a backslash.
    NotAKey(KeyRefusal),
}

impl std::fmt::Display for PathRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathRefusal::NotRelative => f.write_str("the path is not relative"),
            PathRefusal::NotNormal => f.write_str("the path has a \".\" or \"..\" component"),
            PathRefusal::NotUtf8 => f.write_str("the path is not valid UTF-8"),
            PathRefusal::NotAKey(refusal) => write!(f, "the path is not a key: {refusal}"),
        }
    }
}

impl std::error::Error for PathRefusal {}

/// The key of the file at `path`, relative to the store's directory: its components joined with `/`, the inverse of [`key_to_relative_path`].
///
/// # Errors
///
/// A [`PathRefusal`] when the path is not relative, has a component that is not an ordinary name, is not UTF-8, or spells a string that is not a key.
pub fn relative_path_to_key(path: &Path) -> Result<String, PathRefusal> {
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                segments.push(name.to_str().ok_or(PathRefusal::NotUtf8)?);
            }
            Component::CurDir | Component::ParentDir => return Err(PathRefusal::NotNormal),
            Component::RootDir | Component::Prefix(_) => return Err(PathRefusal::NotRelative),
        }
    }
    let key = segments.join("/");
    check_key(&key).map_err(PathRefusal::NotAKey)?;
    Ok(key)
}

/// The content of the file that holds `value`: the value's bytes and nothing else, with no header, framing or terminator.
#[must_use]
pub fn file_contents(value: &[u8]) -> &[u8] {
    value
}

/// The value held by a file with the content `contents`: all of it.
#[must_use]
pub fn value_from_file_contents(contents: &[u8]) -> &[u8] {
    contents
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_of_ordinary_segments_is_its_own_relative_path() {
        let path = key_to_relative_path("data/ab/entry/1").expect("a key");
        assert_eq!(path, Path::new("data").join("ab").join("entry").join("1"));
        assert_eq!(
            relative_path_to_key(&path).as_deref(),
            Ok("data/ab/entry/1")
        );
    }

    #[test]
    fn each_rule_names_its_own_refusal() {
        let cases = [
            ("", KeyRefusal::Empty),
            ("a\0b", KeyRefusal::Nul),
            ("a\\b", KeyRefusal::Backslash),
            ("/a", KeyRefusal::Absolute),
            ("a//b", KeyRefusal::EmptySegment),
            ("a/", KeyRefusal::EmptySegment),
            ("a/./b", KeyRefusal::DotSegment),
            (".", KeyRefusal::DotSegment),
            ("a/../b", KeyRefusal::ParentSegment),
            ("..", KeyRefusal::ParentSegment),
            ("C:/x", KeyRefusal::DrivePrefix),
            ("a/C:/x", KeyRefusal::DrivePrefix),
            ("C:foo", KeyRefusal::DrivePrefix),
            ("c:", KeyRefusal::DrivePrefix),
            ("a:b", KeyRefusal::DrivePrefix),
        ];
        for (key, refusal) in cases {
            assert_eq!(check_key(key), Err(refusal), "{key:?}");
        }
        for refusal in KeyRefusal::ALL {
            assert!(
                cases.iter().any(|(_, held)| *held == refusal),
                "no case for {}",
                refusal.as_str()
            );
        }
    }

    #[test]
    fn the_first_rule_broken_is_the_one_named() {
        assert_eq!(check_key("/a\0"), Err(KeyRefusal::Nul));
        assert_eq!(check_key("/a\\"), Err(KeyRefusal::Backslash));
        assert_eq!(check_key("/.."), Err(KeyRefusal::Absolute));
        assert_eq!(check_key("./.."), Err(KeyRefusal::DotSegment));
        assert_eq!(check_key("../."), Err(KeyRefusal::ParentSegment));
        assert_eq!(check_key("a//.."), Err(KeyRefusal::EmptySegment));
        assert_eq!(check_key("C:/.."), Err(KeyRefusal::DrivePrefix));
        assert_eq!(check_key("../C:"), Err(KeyRefusal::ParentSegment));
    }

    #[test]
    fn a_key_the_layout_accepts_is_a_path_of_ordinary_names_on_every_host() {
        for key in ["a/bc:d", "1:a", "ab:c", "a/b", "é:a", "a/.b:c"] {
            let path = key_to_relative_path(key).expect(key);
            assert!(
                path.components()
                    .all(|component| matches!(component, Component::Normal(_))),
                "{key:?} builds a path with a prefix or a root: {path:?}"
            );
            assert_eq!(path.components().count(), key.split('/').count(), "{key:?}");
        }
    }

    #[test]
    fn names_that_only_resemble_the_reserved_segments_are_keys() {
        for key in [
            "...",
            "a/..b",
            ".a",
            "a./b",
            " ",
            ".DS_Store",
            "a b/c",
            "a/bc:d",
            "1:a",
        ] {
            assert_eq!(check_key(key), Ok(()), "{key:?}");
        }
    }

    #[test]
    fn a_path_that_is_not_the_path_of_a_key_is_refused() {
        assert_eq!(
            relative_path_to_key(Path::new("/a")),
            Err(PathRefusal::NotRelative)
        );
        assert_eq!(
            relative_path_to_key(Path::new("a/../b")),
            Err(PathRefusal::NotNormal)
        );
        assert_eq!(
            relative_path_to_key(Path::new("./a")),
            Err(PathRefusal::NotNormal)
        );
        assert_eq!(
            relative_path_to_key(Path::new("a\\b")),
            Err(PathRefusal::NotAKey(KeyRefusal::Backslash))
        );
        assert_eq!(
            relative_path_to_key(Path::new("")),
            Err(PathRefusal::NotAKey(KeyRefusal::Empty))
        );
    }

    #[test]
    fn a_value_is_the_whole_file() {
        let value = [0u8, 1, 2, 255];
        assert_eq!(file_contents(&value), value);
        assert_eq!(value_from_file_contents(&value), value);
    }
}
