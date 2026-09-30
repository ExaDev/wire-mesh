// Bridges a MeshSession's own events AsyncIterable onto React's push-based re-render model -- the one place this console adapts the domain layer's pull-based iterator to a hook, so every consuming component just reads plain state. The session's event stream has a single reader, so the human-readable activity is accumulated here from the same events rather than by a second consumer.

import { useEffect, useState } from "react";
import type {
  MeshSession,
  SessionEvent,
} from "wire-mesh-core/domain/mesh-session";
import type { Clock } from "wire-mesh-core/ports/clock";
import { advanceActivity, initialTracker } from "../activity.js";
import type { ActivityEntry } from "../activity.js";

/** The most activity entries kept per connection. The raw frame log is unbounded in the session itself; the activity view is what stays on screen, so it keeps the most recent entries and drops the oldest. */
export const MAX_ACTIVITY_ENTRIES = 500;

export interface MeshSessionView {
  /** The latest SessionEvent, undefined until the first arrives (the session's own initial "idle" snapshot). */
  event: SessionEvent | undefined;
  /** What happened on the connection, oldest first. */
  activity: readonly ActivityEntry[];
  /** When the connection's status last changed, from `clock`, or undefined before the first event. */
  statusSince: number | undefined;
}

/** Mirrors the latest SessionEvent a MeshSession yields into React state, with the activity and status timing derived from the whole stream of events. */
export function useMeshSessionEvents(
  session: Readonly<MeshSession>,
  clock: Readonly<Clock>,
): MeshSessionView {
  const [view, setView] = useState<MeshSessionView>({
    event: undefined,
    activity: [],
    statusSince: undefined,
  });

  useEffect(() => {
    // A mutable object property, not a plain `let`, so the compiler can't narrow this to a literal `false` inside the loop below -- the cleanup closure genuinely can flip it between iterations, on the next tick after an await, which a plain boolean's own static narrowing doesn't account for.
    const lifecycle = { cancelled: false };
    void (async (): Promise<void> => {
      let tracker = initialTracker;
      for await (const sessionEvent of session.events) {
        if (lifecycle.cancelled) {
          return;
        }
        const at = clock.now();
        const advanced = advanceActivity(tracker, sessionEvent, at);
        const stageChanged = advanced.tracker.stage !== tracker.stage;
        tracker = advanced.tracker;
        setView((current) => ({
          event: sessionEvent,
          activity: [...current.activity, ...advanced.entries].slice(
            -MAX_ACTIVITY_ENTRIES,
          ),
          statusSince: stageChanged ? at : current.statusSince,
        }));
      }
    })();
    return () => {
      lifecycle.cancelled = true;
    };
  }, [session, clock]);

  return view;
}
