//! An in-memory `BTreeMap`-backed KeyValueStorage adapter, the first-pass storage implementation and the test harness default. Real deployments swap in a persistent adapter behind the same port.

use std::collections::BTreeMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::ports::{CoreError, KeyValueStorage};

#[derive(Debug, Clone, Default)]
pub struct MemoryStorage {
    map: Arc<RwLock<BTreeMap<String, Vec<u8>>>>,
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl KeyValueStorage for MemoryStorage {
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, CoreError> {
        let map = self.map.read().await;
        Ok(map.get(key).cloned())
    }

    async fn set(&self, key: &str, value: Vec<u8>) -> Result<(), CoreError> {
        let mut map = self.map.write().await;
        map.insert(key.to_owned(), value);
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), CoreError> {
        let mut map = self.map.write().await;
        map.remove(key);
        Ok(())
    }

    async fn keys(&self, prefix: &str) -> Result<Vec<String>, CoreError> {
        let map = self.map.read().await;
        Ok(map
            .range(prefix.to_owned()..)
            .take_while(|(k, _)| k.starts_with(prefix))
            .map(|(k, _)| k.clone())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn crud_and_prefix_enumeration() {
        let storage = MemoryStorage::new();
        storage.set("revocations/a", vec![1]).await.expect("set");
        storage.set("revocations/b", vec![2]).await.expect("set");
        storage.set("oplog/peer-1/0", vec![3]).await.expect("set");
        assert_eq!(
            storage.get("revocations/a").await.expect("get"),
            Some(vec![1])
        );
        assert_eq!(storage.get("missing").await.expect("get"), None);
        assert_eq!(
            storage.keys("revocations/").await.expect("keys"),
            vec!["revocations/a".to_owned(), "revocations/b".to_owned()]
        );
        storage.delete("revocations/a").await.expect("delete");
        assert_eq!(storage.get("revocations/a").await.expect("get"), None);
        assert_eq!(
            storage.keys("revocations/").await.expect("keys"),
            vec!["revocations/b".to_owned()]
        );
    }
}
