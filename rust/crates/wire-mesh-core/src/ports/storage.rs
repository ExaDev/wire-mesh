//! The storage port. Values are opaque bytes — a revocation entry, an
//! oplog entry; callers encode and decode with the wire types, exactly as
//! the protocol's own data domain treats its entries.

use crate::ports::CoreError;

/// Key-value storage with prefix enumeration, mirroring the TypeScript
/// core's storage contract.
#[async_trait::async_trait]
pub trait KeyValueStorage: Send + Sync {
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, CoreError>;
    async fn set(&self, key: &str, value: Vec<u8>) -> Result<(), CoreError>;
    async fn delete(&self, key: &str) -> Result<(), CoreError>;
    /// All keys starting with `prefix`, in lexicographic order.
    async fn keys(&self, prefix: &str) -> Result<Vec<String>, CoreError>;
}
