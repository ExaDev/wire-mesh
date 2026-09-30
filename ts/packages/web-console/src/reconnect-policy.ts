// How a session redials a dropped connection. Exponential backoff, capped at 30s, giving up after 5 attempts: reasonable defaults for a browser console reconnecting to a relay that may just be restarting, without retrying forever against one that is genuinely gone. Shared so the connection panel can say when the next attempt is due from the same numbers the session uses.

import type { ReconnectPolicy } from "wire-mesh-core/domain/mesh-session";

const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_BASE = 2;

export const reconnectPolicy: ReconnectPolicy = {
  maxAttempts: RECONNECT_MAX_ATTEMPTS,
  delayMs: (attempt) =>
    Math.min(
      RECONNECT_BASE_DELAY_MS * RECONNECT_BACKOFF_BASE ** (attempt - 1),
      RECONNECT_MAX_DELAY_MS,
    ),
};
