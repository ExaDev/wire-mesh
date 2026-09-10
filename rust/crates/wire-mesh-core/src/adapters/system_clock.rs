//! The wall-clock adapter: `SystemTime` to Unix milliseconds. Domain logic never calls `SystemTime` directly (it takes a `Clock` port), so a test harness or a Cloudflare Worker can supply its own notion of now.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::ports::Clock;

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}
