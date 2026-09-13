// Bridges a MeshSession's own events AsyncIterable onto React's push-based re-render model -- the one place this console adapts the domain layer's pull-based iterator to a hook, so every consuming component just reads plain state.

import { useEffect, useState } from "react";
import type {
  MeshSession,
  SessionEvent,
} from "wire-mesh-core/domain/mesh-session";

/** Mirrors the latest SessionEvent a MeshSession yields into React state. Returns undefined until the first event arrives (the session's own initial "idle" snapshot). */
export function useMeshSessionEvents(
  session: Readonly<MeshSession>,
): SessionEvent | undefined {
  const [event, setEvent] = useState<SessionEvent | undefined>(undefined);

  useEffect(() => {
    // A mutable object property, not a plain `let`, so the compiler can't narrow this to a literal `false` inside the loop below -- the cleanup closure genuinely can flip it between iterations, on the next tick after an await, which a plain boolean's own static narrowing doesn't account for.
    const lifecycle = { cancelled: false };
    void (async (): Promise<void> => {
      for await (const sessionEvent of session.events) {
        if (lifecycle.cancelled) {
          return;
        }
        setEvent(sessionEvent);
      }
    })();
    return () => {
      lifecycle.cancelled = true;
    };
  }, [session]);

  return event;
}
