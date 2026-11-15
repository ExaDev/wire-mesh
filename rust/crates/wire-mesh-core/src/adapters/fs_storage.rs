//! A filesystem-backed `KeyValueStorage`, the durable counterpart of [`super::MemoryStorage`], with the layout of the TypeScript `createNodeFsStorage` ([`crate::domain::fs_layout`]): a key is the path of a file under the directory, and the file holds the value and nothing else.
//!
//! A write replaces the file in place, as the TypeScript does, so a failure part way can leave a truncated file, and a reader can see a partial value: callers that need an entry written or not at all keep that guarantee in their own record format, as the log of `domain::data_sync` does by writing the head after the entry it covers. That ordering holds against a crash of the process, not against a power loss or a kernel crash, since nothing is flushed to the disk before the next write. A key the layout refuses is an error, never rewritten into another name. A listing skips a file whose name the layout refuses (one with a backslash, or a name that is not UTF-8, which no key names), as the TypeScript does for a backslash, so every listed key can be passed to `get`, `set` and `delete`.
//!
//! The text of an error names the host path of the file, so log it and never send it to a peer.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::domain::fs_layout::{
    file_contents, key_to_relative_path, relative_path_to_key, value_from_file_contents,
};
use crate::ports::{CoreError, KeyValueStorage};

/// Key-value storage in a directory. The directory is created on the first write.
#[derive(Debug, Clone)]
pub struct FsStorage {
    dir: PathBuf,
}

fn storage_error(what: &str, path: &Path, error: &std::io::Error) -> CoreError {
    CoreError::Storage(format!("{what} {}: {error}", path.display()))
}

impl FsStorage {
    /// Storage under `dir`.
    #[must_use]
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        FsStorage { dir: dir.into() }
    }

    fn file_of(&self, key: &str) -> Result<PathBuf, CoreError> {
        let relative = key_to_relative_path(key)
            .map_err(|refusal| CoreError::Storage(format!("invalid key {key:?}: {refusal}")))?;
        Ok(self.dir.join(relative))
    }
}

/// Every regular file under `dir`, as a path relative to it. A symbolic link to a directory is not entered, and one to a file is a file, as Node's recursive `readdir` followed by `stat` has it. A missing `dir` holds nothing.
async fn files_under(dir: &Path) -> Result<Vec<PathBuf>, CoreError> {
    let mut found = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let here = dir.join(&relative);
        let mut entries = match tokio::fs::read_dir(&here).await {
            Ok(entries) => entries,
            Err(error)
                if error.kind() == ErrorKind::NotFound && relative.as_os_str().is_empty() =>
            {
                return Ok(Vec::new());
            }
            Err(error) => return Err(storage_error("cannot list", &here, &error)),
        };
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| storage_error("cannot list", &here, &error))?
        {
            let path = entry.path();
            let child = relative.join(entry.file_name());
            let kind = entry
                .file_type()
                .await
                .map_err(|error| storage_error("cannot stat", &path, &error))?;
            if kind.is_dir() {
                pending.push(child);
            } else if kind.is_file() {
                found.push(child);
            } else if kind.is_symlink() {
                // A link to a file is a file; a dangling link or a link to a directory is neither.
                if tokio::fs::metadata(&path)
                    .await
                    .is_ok_and(|meta| meta.is_file())
                {
                    found.push(child);
                }
            }
        }
    }
    Ok(found)
}

#[async_trait::async_trait]
impl KeyValueStorage for FsStorage {
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, CoreError> {
        let path = self.file_of(key)?;
        match tokio::fs::read(&path).await {
            Ok(contents) => Ok(Some(value_from_file_contents(&contents).to_vec())),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(storage_error("cannot read", &path, &error)),
        }
    }

    async fn set(&self, key: &str, value: Vec<u8>) -> Result<(), CoreError> {
        let path = self.file_of(key)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| storage_error("cannot create", parent, &error))?;
        }
        tokio::fs::write(&path, file_contents(&value))
            .await
            .map_err(|error| storage_error("cannot write", &path, &error))
    }

    async fn delete(&self, key: &str) -> Result<(), CoreError> {
        let path = self.file_of(key)?;
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(storage_error("cannot remove", &path, &error)),
        }
    }

    async fn keys(&self, prefix: &str) -> Result<Vec<String>, CoreError> {
        let mut keys = Vec::new();
        for relative in files_under(&self.dir).await? {
            if let Ok(key) = relative_path_to_key(&relative) {
                if key.starts_with(prefix) {
                    keys.push(key);
                }
            }
        }
        keys.sort();
        Ok(keys)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    /// A fresh empty directory path that does not exist yet, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            TempDir(std::env::temp_dir().join(format!(
                "wire-mesh-core-fs-storage-{}-{n}",
                std::process::id()
            )))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn a_value_round_trips_and_a_missing_key_is_none() {
        let dir = TempDir::new();
        let storage = FsStorage::new(&dir.0);
        assert_eq!(storage.get("a").await, Ok(None));
        storage.set("a/b/c", vec![0, 1, 255]).await.expect("set");
        assert_eq!(storage.get("a/b/c").await, Ok(Some(vec![0, 1, 255])));
        assert_eq!(
            std::fs::read(dir.0.join("a").join("b").join("c")).expect("the file"),
            vec![0, 1, 255]
        );
    }

    #[tokio::test]
    async fn a_second_set_replaces_the_value_and_a_delete_removes_it_and_tolerates_absence() {
        let dir = TempDir::new();
        let storage = FsStorage::new(&dir.0);
        storage.set("k", vec![1, 2, 3]).await.expect("set");
        storage.set("k", vec![9]).await.expect("overwrite");
        assert_eq!(storage.get("k").await, Ok(Some(vec![9])));
        storage.delete("k").await.expect("delete");
        assert_eq!(storage.get("k").await, Ok(None));
        storage.delete("k").await.expect("delete of an absent key");
    }

    #[tokio::test]
    async fn keys_lists_the_files_under_the_prefix_in_order_and_an_absent_directory_holds_nothing()
    {
        let dir = TempDir::new();
        let storage = FsStorage::new(&dir.0);
        assert_eq!(storage.keys("").await, Ok(vec![]));
        for key in ["b/2", "a/1", "a/10", "a/2", "c"] {
            storage.set(key, vec![0]).await.expect("set");
        }
        assert_eq!(
            storage.keys("a/").await,
            Ok(vec!["a/1".to_owned(), "a/10".to_owned(), "a/2".to_owned()])
        );
        assert_eq!(storage.keys("").await.expect("all").len(), 5);
        assert_eq!(storage.keys("nothing").await, Ok(vec![]));
    }

    #[tokio::test]
    async fn a_key_the_layout_refuses_is_an_error_for_every_operation_and_writes_nothing() {
        let dir = TempDir::new();
        let storage = FsStorage::new(&dir.0);
        for key in ["", "../x", "a/../x", "a//b", "/abs", "a/./b", "a/", "a\\b"] {
            assert!(
                matches!(storage.get(key).await, Err(CoreError::Storage(_))),
                "{key:?}"
            );
            assert!(
                matches!(storage.set(key, vec![1]).await, Err(CoreError::Storage(_))),
                "{key:?}"
            );
            assert!(
                matches!(storage.delete(key).await, Err(CoreError::Storage(_))),
                "{key:?}"
            );
        }
        assert!(!dir.0.exists(), "a refused key created the directory");
    }

    #[tokio::test]
    async fn a_listing_skips_a_file_whose_name_is_not_a_key_so_every_listed_key_can_be_read() {
        let dir = TempDir::new();
        std::fs::create_dir_all(&dir.0).expect("dir");
        std::fs::write(dir.0.join("a\\b"), b"x").expect("write");
        let storage = FsStorage::new(&dir.0);
        storage.set("kept/a", vec![1]).await.expect("set");
        let listed = storage.keys("").await.expect("a listing");
        assert_eq!(listed, vec!["kept/a".to_owned()]);
        assert!(matches!(
            storage.get("a\\b").await,
            Err(CoreError::Storage(_))
        ));
        for key in listed {
            assert!(matches!(storage.get(&key).await, Ok(Some(_))));
        }
    }

    #[tokio::test]
    async fn a_key_under_a_file_or_naming_a_directory_is_an_io_error_not_absence() {
        let dir = TempDir::new();
        let storage = FsStorage::new(&dir.0);
        storage.set("f", vec![1]).await.expect("set");
        storage.set("d/e", vec![1]).await.expect("set");
        assert!(matches!(
            storage.get("f/g").await,
            Err(CoreError::Storage(_))
        ));
        assert!(matches!(
            storage.set("f/g", vec![1]).await,
            Err(CoreError::Storage(_))
        ));
        assert!(matches!(storage.get("d").await, Err(CoreError::Storage(_))));
        assert!(matches!(
            storage.set("d", vec![1]).await,
            Err(CoreError::Storage(_))
        ));
    }
}
