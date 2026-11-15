//! A clock that never steps backwards: milliseconds from an arbitrary origin (the moment it was made), as `Instant` gives them. Suited to rules measured in elapsed time and not in calendar time, such as the windows of `domain::relay_channels::RelayChannels`.

use std::time::Instant;

use crate::ports::Clock;

#[derive(Debug, Clone, Copy)]
pub struct MonotonicClock {
    origin: Instant,
}

impl MonotonicClock {
    /// A clock whose zero is now.
    #[must_use]
    pub fn new() -> Self {
        MonotonicClock {
            origin: Instant::now(),
        }
    }
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for MonotonicClock {
    /// Milliseconds since the clock was made, not Unix time: the port's name is for the clock most consumers want, and the relay channels read only differences.
    fn now_unix_ms(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}
