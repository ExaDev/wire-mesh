//! `exec.cddl` — the `$manage-command-params` members and session
//! enumeration for core/exec: process and PTY control riding manage-request
//! frames. Only stdio gets dedicated stream frames; control verbs never do.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::streaming::StreamSession;
use crate::strict;
use crate::value::CanonicalMap;

/// `env: {* tstr => tstr}` — canonical (CDE-ordered) string-to-string map.
pub type Env = CanonicalMap<String, String>;

/// `pty-spawn = { verb: "pty.spawn", ? shell, argv, ? cwd, env, cols, rows }`.
///
/// CDE key order over the full key set: `cwd` (4), `env` (4), `argv` (5),
/// `cols` (5), `rows` (5), `verb` (5), `shell` (6), each present key in
/// that fixed relative order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtySpawn {
    pub shell: Option<String>,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: Env,
    pub cols: u64,
    pub rows: u64,
}

impl PtySpawn {
    pub const VERB: &'static str = "pty.spawn";
}

impl Encode<()> for PtySpawn {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 5 + usize::from(self.shell.is_some()) + usize::from(self.cwd.is_some());
        e.map(len as u64)?;
        if let Some(cwd) = &self.cwd {
            e.str("cwd")?.str(cwd)?;
        }
        e.str("env")?.map(self.env.len() as u64)?;
        for (k, v) in self.env.iter() {
            e.str(k)?.str(v)?;
        }
        e.str("argv")?.array(self.argv.len() as u64)?;
        for arg in &self.argv {
            e.str(arg)?;
        }
        e.str("cols")?.u64(self.cols)?;
        e.str("rows")?.u64(self.rows)?;
        e.str("verb")?.str(Self::VERB)?;
        if let Some(shell) = &self.shell {
            e.str("shell")?.str(shell)?;
        }
        e.ok()
    }
}

impl PtySpawn {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut shell: Option<String> = None;
        let mut argv: Option<Vec<String>> = None;
        let mut cwd: Option<String> = None;
        let mut env: Option<Env> = None;
        let mut cols: Option<u64> = None;
        let mut rows: Option<u64> = None;
        param::decode_params_map(d, PtySpawn::VERB, &mut |d, key| {
            match key {
                "shell" => strict::set_once(&mut shell, strict::text_value(d)?)?,
                "argv" => strict::set_once(&mut argv, param::decode_string_array(d)?)?,
                "cwd" => strict::set_once(&mut cwd, strict::text_value(d)?)?,
                "env" => strict::set_once(&mut env, param::decode_env(d)?)?,
                "cols" => strict::set_once(&mut cols, strict::uint_value(d)?)?,
                "rows" => strict::set_once(&mut rows, strict::uint_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(PtySpawn {
            shell,
            argv: argv.ok_or(DecodeError::MissingField("argv"))?,
            cwd,
            env: env.ok_or(DecodeError::MissingField("env"))?,
            cols: cols.ok_or(DecodeError::MissingField("cols"))?,
            rows: rows.ok_or(DecodeError::MissingField("rows"))?,
        })
    }
}

/// `pty-write = { verb, session, bytes }`. CDE key order: `verb` (5),
/// `bytes` (6), `session` (8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyWrite {
    pub session: StreamSession,
    pub bytes: Vec<u8>,
}

impl PtyWrite {
    pub const VERB: &'static str = "pty.write";
}

impl Encode<()> for PtyWrite {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("bytes")?.bytes(&self.bytes)?;
        e.str("session")?.u64(self.session.0)?;
        e.ok()
    }
}

impl PtyWrite {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session: Option<u64> = None;
        let mut bytes: Option<Vec<u8>> = None;
        param::decode_params_map(d, PtyWrite::VERB, &mut |d, key| {
            match key {
                "session" => strict::set_once(&mut session, strict::uint_value(d)?)?,
                "bytes" => strict::set_once(&mut bytes, strict::bytes_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(PtyWrite {
            session: StreamSession(session.ok_or(DecodeError::MissingField("session"))?),
            bytes: bytes.ok_or(DecodeError::MissingField("bytes"))?,
        })
    }
}

/// `pty-resize = { verb, session, cols, rows }`. CDE key order: `cols` (5),
/// `rows` (5), `verb` (5), `session` (8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtyResize {
    pub session: StreamSession,
    pub cols: u64,
    pub rows: u64,
}

impl PtyResize {
    pub const VERB: &'static str = "pty.resize";
}

impl Encode<()> for PtyResize {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(4)?;
        e.str("cols")?.u64(self.cols)?;
        e.str("rows")?.u64(self.rows)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("session")?.u64(self.session.0)?;
        e.ok()
    }
}

impl PtyResize {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session: Option<u64> = None;
        let mut cols: Option<u64> = None;
        let mut rows: Option<u64> = None;
        param::decode_params_map(d, PtyResize::VERB, &mut |d, key| {
            match key {
                "session" => strict::set_once(&mut session, strict::uint_value(d)?)?,
                "cols" => strict::set_once(&mut cols, strict::uint_value(d)?)?,
                "rows" => strict::set_once(&mut rows, strict::uint_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(PtyResize {
            session: StreamSession(session.ok_or(DecodeError::MissingField("session"))?),
            cols: cols.ok_or(DecodeError::MissingField("cols"))?,
            rows: rows.ok_or(DecodeError::MissingField("rows"))?,
        })
    }
}

/// `pty-kill = { verb, session, signal }`. CDE key order: `verb` (5),
/// `session` (8; bytewise before `signal`), `signal` (8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtyKill {
    pub session: StreamSession,
    pub signal: i64,
}

impl PtyKill {
    pub const VERB: &'static str = "pty.kill";
}

impl Encode<()> for PtyKill {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("session")?.u64(self.session.0)?;
        e.str("signal")?.i64(self.signal)?;
        e.ok()
    }
}

impl PtyKill {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session: Option<u64> = None;
        let mut signal: Option<i64> = None;
        param::decode_params_map(d, PtyKill::VERB, &mut |d, key| {
            match key {
                "session" => strict::set_once(&mut session, strict::uint_value(d)?)?,
                "signal" => strict::set_once(&mut signal, strict::int_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(PtyKill {
            session: StreamSession(session.ok_or(DecodeError::MissingField("session"))?),
            signal: signal.ok_or(DecodeError::MissingField("signal"))?,
        })
    }
}

/// `proc-spawn = { verb, argv, ? cwd, env }`. CDE key order: `cwd` (4),
/// `env` (4), `argv` (5), `verb` (5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcSpawn {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: Env,
}

impl ProcSpawn {
    pub const VERB: &'static str = "proc.spawn";
}

impl Encode<()> for ProcSpawn {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 3 + usize::from(self.cwd.is_some());
        e.map(len as u64)?;
        if let Some(cwd) = &self.cwd {
            e.str("cwd")?.str(cwd)?;
        }
        e.str("env")?.map(self.env.len() as u64)?;
        for (k, v) in self.env.iter() {
            e.str(k)?.str(v)?;
        }
        e.str("argv")?.array(self.argv.len() as u64)?;
        for arg in &self.argv {
            e.str(arg)?;
        }
        e.str("verb")?.str(Self::VERB)?;
        e.ok()
    }
}

impl ProcSpawn {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut argv: Option<Vec<String>> = None;
        let mut cwd: Option<String> = None;
        let mut env: Option<Env> = None;
        param::decode_params_map(d, ProcSpawn::VERB, &mut |d, key| {
            match key {
                "argv" => strict::set_once(&mut argv, param::decode_string_array(d)?)?,
                "cwd" => strict::set_once(&mut cwd, strict::text_value(d)?)?,
                "env" => strict::set_once(&mut env, param::decode_env(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(ProcSpawn {
            argv: argv.ok_or(DecodeError::MissingField("argv"))?,
            cwd,
            env: env.ok_or(DecodeError::MissingField("env"))?,
        })
    }
}

/// `proc-signal = { verb, session, signal }`. Same key set as pty-kill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcSignal {
    pub session: StreamSession,
    pub signal: i64,
}

impl ProcSignal {
    pub const VERB: &'static str = "proc.signal";
}

impl Encode<()> for ProcSignal {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("session")?.u64(self.session.0)?;
        e.str("signal")?.i64(self.signal)?;
        e.ok()
    }
}

impl ProcSignal {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session: Option<u64> = None;
        let mut signal: Option<i64> = None;
        param::decode_params_map(d, ProcSignal::VERB, &mut |d, key| {
            match key {
                "session" => strict::set_once(&mut session, strict::uint_value(d)?)?,
                "signal" => strict::set_once(&mut signal, strict::int_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(ProcSignal {
            session: StreamSession(session.ok_or(DecodeError::MissingField("session"))?),
            signal: signal.ok_or(DecodeError::MissingField("signal"))?,
        })
    }
}

/// `proc-kill = { verb, session }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcKill {
    pub session: StreamSession,
}

impl ProcKill {
    pub const VERB: &'static str = "proc.kill";
}

impl Encode<()> for ProcKill {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("verb")?.str(Self::VERB)?;
        e.str("session")?.u64(self.session.0)?;
        e.ok()
    }
}

impl ProcKill {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut session: Option<u64> = None;
        param::decode_params_map(d, ProcKill::VERB, &mut |d, key| {
            match key {
                "session" => strict::set_once(&mut session, strict::uint_value(d)?)?,
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
            Ok(())
        })?;
        Ok(ProcKill {
            session: StreamSession(session.ok_or(DecodeError::MissingField("session"))?),
        })
    }
}

/// `exec-list = { verb: "exec.list" }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExecList;

impl ExecList {
    pub const VERB: &'static str = "exec.list";
}

impl Encode<()> for ExecList {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(1)?;
        e.str("verb")?.str(Self::VERB)?;
        e.ok()
    }
}

impl ExecList {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        param::decode_params_map(d, ExecList::VERB, &mut |_d, key| {
            Err(DecodeError::UnknownKey(key.to_owned()))
        })?;
        Ok(ExecList)
    }
}

/// `exec-session-info = { session, kind: "pty" / "proc", ? argv, ? cwd }`.
///
/// Not a frame: manage-ok's answer to exec.list rides the open tail of
/// `manage-ok` as an array of these. CDE key order: `cwd` (4 encoded key
/// bytes) sorts first; `argv` and `kind` each encode to 5 bytes and tie-break
/// bytewise (`argv` < `kind`); `session` (8) sorts last.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecSessionInfo {
    pub session: StreamSession,
    pub kind: ExecSessionKind,
    pub argv: Option<Vec<String>>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecSessionKind {
    Pty,
    Proc,
}

impl ExecSessionKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            ExecSessionKind::Pty => "pty",
            ExecSessionKind::Proc => "proc",
        }
    }
}

impl Encode<()> for ExecSessionInfo {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 2 + usize::from(self.argv.is_some()) + usize::from(self.cwd.is_some());
        e.map(len as u64)?;
        // CDE key order: "cwd" (4 encoded bytes), then "argv" and "kind" (5 bytes each, "argv" < "kind" bytewise), then "session" (8).
        if let Some(cwd) = &self.cwd {
            e.str("cwd")?.str(cwd)?;
        }
        if let Some(argv) = &self.argv {
            e.str("argv")?.array(argv.len() as u64)?;
            for arg in argv {
                e.str(arg)?;
            }
        }
        e.str("kind")?.str(self.kind.as_str())?;
        e.str("session")?.u64(self.session.0)?;
        e.ok()
    }
}

impl Decode<'_, ()> for ExecSessionInfo {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        exec_session_info_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn exec_session_info_from(d: &mut Decoder<'_>) -> Result<ExecSessionInfo, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut session: Option<u64> = None;
    let mut kind: Option<ExecSessionKind> = None;
    let mut argv: Option<Vec<String>> = None;
    let mut cwd: Option<String> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "session" => strict::set_once(&mut session, strict::uint_value(d)?)?,
            "kind" => {
                let found = strict::text_value(d)?;
                kind = Some(match found.as_str() {
                    "pty" => ExecSessionKind::Pty,
                    "proc" => ExecSessionKind::Proc,
                    other => {
                        return Err(DecodeError::BadLiteral {
                            expected: "pty | proc",
                            found: other.to_owned(),
                        })
                    }
                });
            }
            "argv" => strict::set_once(&mut argv, param::decode_string_array(d)?)?,
            "cwd" => strict::set_once(&mut cwd, strict::text_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(ExecSessionInfo {
        session: StreamSession(session.ok_or(DecodeError::MissingField("session"))?),
        kind: kind.ok_or(DecodeError::MissingField("kind"))?,
        argv,
        cwd,
    })
}

/// Shared decode helpers for the `$manage-command-params` members. A
/// private submodule so the helper names do not collide with the type
/// names above.
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

    pub(super) fn decode_string_array(d: &mut Decoder<'_>) -> Result<Vec<String>, DecodeError> {
        let count = strict::definite_array(d)?;
        let mut list = Vec::new();
        for _ in 0..count {
            list.push(strict::text_value(d)?);
        }
        Ok(list)
    }

    pub(super) fn decode_env(d: &mut Decoder<'_>) -> Result<Env, DecodeError> {
        let mut map = strict::MapDecoder::new(d)?;
        let mut env = CanonicalMap::new();
        while let Some(key) = map.next_key(d)? {
            let value = strict::text_value(d)?;
            env.insert(key.to_owned(), value)?;
        }
        Ok(env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip<T: Encode<()> + PartialEq + core::fmt::Debug>(value: T) -> Vec<u8> {
        let bytes = minicbor::to_vec(value).expect("encode");
        // Params types are decoded through the management module's
        // dispatch; here we pin encode output byte-for-byte against the
        // expected CDE key order using key positions.
        bytes
    }

    #[test]
    fn pty_spawn_key_order_matches_frozen_vector_shape() {
        let mut env = CanonicalMap::new();
        env.insert("PATH".to_owned(), "/bin".to_owned())
            .expect("unique");
        let spawn = PtySpawn {
            shell: Some("/bin/sh".to_owned()),
            argv: vec![],
            cwd: Some("/work".to_owned()),
            env,
            cols: 80,
            rows: 24,
        };
        let bytes = round_trip(&spawn);
        // cwd, env, argv, cols, rows, verb, shell — the exact order of the
        // frozen manage_request_v1_pty_spawn vector's params map.
        let order: Vec<usize> = ["cwd", "env", "argv", "cols", "rows", "verb", "shell"]
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
        assert_eq!(bytes[0], 0xa7);
    }

    #[test]
    fn exec_session_info_round_trip() {
        let info = ExecSessionInfo {
            session: StreamSession(9),
            kind: ExecSessionKind::Pty,
            argv: Some(vec!["sh".to_owned()]),
            cwd: None,
        };
        let bytes = minicbor::to_vec(&info).expect("encode");
        let back: ExecSessionInfo = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, info);
        let kind_at = bytes.windows(4).position(|w| w == b"kind").expect("kind");
        let argv_at = bytes.windows(4).position(|w| w == b"argv").expect("argv");
        let session_at = bytes
            .windows(7)
            .position(|w| w == b"session")
            .expect("session");
        assert!(argv_at < kind_at && kind_at < session_at);
    }

    #[test]
    fn exec_session_info_round_trip_with_both_argv_and_cwd() {
        let info = ExecSessionInfo {
            session: StreamSession(9),
            kind: ExecSessionKind::Proc,
            argv: Some(vec!["sh".to_owned(), "-c".to_owned()]),
            cwd: Some("/work".to_owned()),
        };
        let bytes = minicbor::to_vec(&info).expect("encode");
        let back: ExecSessionInfo = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, info);
        let cwd_at = bytes.windows(3).position(|w| w == b"cwd").expect("cwd");
        let argv_at = bytes.windows(4).position(|w| w == b"argv").expect("argv");
        let kind_at = bytes.windows(4).position(|w| w == b"kind").expect("kind");
        let session_at = bytes
            .windows(7)
            .position(|w| w == b"session")
            .expect("session");
        assert!(cwd_at < argv_at && argv_at < kind_at && kind_at < session_at);
    }

    #[test]
    fn env_map_rejects_unsorted_keys() {
        // { "b": "1", "a": "2" } — same-length keys out of bytewise order.
        let bytes = [0xA2, 0x61, b'b', 0x61, b'1', 0x61, b'a', 0x61, b'2'];
        let mut d = Decoder::new(&bytes);
        assert_eq!(param::decode_env(&mut d), Err(DecodeError::UnsortedMapKeys));
    }
}
