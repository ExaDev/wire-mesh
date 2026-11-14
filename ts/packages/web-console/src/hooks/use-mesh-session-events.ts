// Bridges a MeshSession's own events AsyncIterable onto React's push-based re-render model, the one place this console adapts the domain layer's pull-based iterator to a hook, so every consuming component just reads plain state. The session's event stream has a single reader, so the human-readable activity is accumulated here from the same events rather than by a second consumer.

import { consumeEach } from "wire-mesh-core/domain/consume-incoming";
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
  session: Readonly<Pick<MeshSession, "events">>,
  clock: Readonly<Clock>,
): MeshSessionView {
  const [view, setView] = useState<MeshSessionView>({
    event: undefined,
    activity: [],
    statusSince: undefined,
  });

  useEffect(() => {
    // Aborted by the cleanup: the loop ends at once and withdraws its wait on the session's stream, so a cancelled effect never takes an event a live one needs (the stream wakes one reader per event).
    const cancelled = new AbortController();
    let tracker = initialTracker;
    void consumeEach(
      session.events,
      (sessionEvent) => {
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
      },
      { signal: cancelled.signal },
    );

    return () => {
      cancelled.abort();
    };
  }, [session, clock]);

  return view;
}
