//! The clock port. Every timestamp the protocol carries (token `expires`/`not-before`, `revoked-at`, handle `issued`/`expires`) is Unix milliseconds compared against this port, never against `SystemTime` directly, keeping expiry checks deterministic under test.

pub trait Clock: Send + Sync {
    /// Current Unix time in milliseconds.
    fn now_unix_ms(&self) -> u64;
}
