//! A JSON object read field by field, so that a field nothing reads fails the run instead of going unnoticed. Shared by the checkers of every vector section.

use serde_json::{Map, Value};

use super::decode_hex;

/// What a check of one vector reports: nothing, or why it failed.
pub(crate) type Check = Result<(), String>;

/// A JSON object read field by field. [`Obj::finish`] fails while any field is left, so a field nothing reads cannot go unnoticed.
pub(crate) struct Obj {
    pub(crate) path: String,
    pub(crate) map: Map<String, Value>,
}

impl Obj {
    pub(crate) fn new(value: &Value, path: impl Into<String>) -> Result<Self, String> {
        let path = path.into();
        let map = value
            .as_object()
            .ok_or_else(|| format!("{path} is not an object"))?
            .clone();
        Ok(Obj { path, map })
    }

    pub(crate) fn take(&mut self, key: &str) -> Result<Value, String> {
        self.map
            .remove(key)
            .ok_or_else(|| format!("{} has no field {key}", self.path))
    }

    pub(crate) fn string(&mut self, key: &str) -> Result<String, String> {
        match self.take(key)? {
            Value::String(text) => Ok(text),
            _ => Err(format!("{}.{key} is not a string", self.path)),
        }
    }

    pub(crate) fn boolean(&mut self, key: &str) -> Result<bool, String> {
        self.take(key)?
            .as_bool()
            .ok_or_else(|| format!("{}.{key} is not a boolean", self.path))
    }

    pub(crate) fn integer(&mut self, key: &str) -> Result<i64, String> {
        self.take(key)?
            .as_i64()
            .ok_or_else(|| format!("{}.{key} is not an integer", self.path))
    }

    pub(crate) fn hex(&mut self, key: &str) -> Result<Vec<u8>, String> {
        let text = self.string(key)?;
        decode_hex(&text).map_err(|e| format!("{}.{key}: {e}", self.path))
    }

    /// A hex field that is `null` when it does not apply.
    pub(crate) fn optional_hex(&mut self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match self.take(key)? {
            Value::Null => Ok(None),
            Value::String(text) => decode_hex(&text)
                .map(Some)
                .map_err(|e| format!("{}.{key}: {e}", self.path)),
            _ => Err(format!("{}.{key} is neither null nor a string", self.path)),
        }
    }

    pub(crate) fn fixed<const N: usize>(&mut self, key: &str) -> Result<[u8; N], String> {
        let bytes = self.hex(key)?;
        <[u8; N]>::try_from(bytes.as_slice())
            .map_err(|_| format!("{}.{key} is {} bytes, not {N}", self.path, bytes.len()))
    }

    pub(crate) fn object(&mut self, key: &str) -> Result<Obj, String> {
        let value = self.take(key)?;
        Obj::new(&value, format!("{}.{key}", self.path))
    }

    pub(crate) fn objects(&mut self, key: &str) -> Result<Vec<Obj>, String> {
        match self.take(key)? {
            Value::Array(items) => items
                .iter()
                .enumerate()
                .map(|(i, item)| Obj::new(item, format!("{}.{key}[{i}]", self.path)))
                .collect(),
            _ => Err(format!("{}.{key} is not an array", self.path)),
        }
    }

    /// A string field that is `null` when it does not apply.
    pub(crate) fn optional_string(&mut self, key: &str) -> Result<Option<String>, String> {
        match self.take(key)? {
            Value::Null => Ok(None),
            Value::String(text) => Ok(Some(text)),
            _ => Err(format!("{}.{key} is neither null nor a string", self.path)),
        }
    }

    /// An unsigned integer field.
    pub(crate) fn unsigned(&mut self, key: &str) -> Result<u64, String> {
        self.take(key)?
            .as_u64()
            .ok_or_else(|| format!("{}.{key} is not an unsigned integer", self.path))
    }

    /// An unsigned integer field that is `null` when it does not apply.
    pub(crate) fn optional_unsigned(&mut self, key: &str) -> Result<Option<u64>, String> {
        match self.take(key)? {
            Value::Null => Ok(None),
            value => value.as_u64().map(Some).ok_or_else(|| {
                format!(
                    "{}.{key} is neither null nor an unsigned integer",
                    self.path
                )
            }),
        }
    }

    /// Fails when the object has a field nothing read.
    pub(crate) fn finish(self) -> Check {
        if self.map.is_empty() {
            Ok(())
        } else {
            let unread: Vec<&str> = self.map.keys().map(String::as_str).collect();
            Err(format!(
                "{} has field(s) this binary does not read: {}",
                self.path,
                unread.join(", ")
            ))
        }
    }
}
