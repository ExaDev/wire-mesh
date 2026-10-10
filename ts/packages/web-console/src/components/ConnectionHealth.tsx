// How healthy one connection is, without anyone pressing ping: the recent round-trip times, and for a dropped connection when the next reconnect attempt is due and how many remain.

import { Group, Text } from "@mantine/core";
import type {
  ConnectionState,
  ReconnectPolicy,
} from "wire-mesh-core/domain/mesh-session";
import { formatRemaining } from "../format-duration.js";
import type { ConnectionHealth as Health } from "../hooks/use-connection-health.js";
import { RttSparkline } from "./RttSparkline.js";

export interface ConnectionHealthProps {
  state: Readonly<ConnectionState>;
  /** When the connection's status last changed, which is when a reconnect's backoff started. */
  statusSince: number | undefined;
  now: number;
  policy: Readonly<ReconnectPolicy>;
  health: Readonly<Health>;
}

function ReconnectStatus({
  state,
  statusSince,
  now,
  policy,
}: Readonly<
  Pick<ConnectionHealthProps, "statusSince" | "now" | "policy"> & {
    state: Extract<ConnectionState, { status: "reconnecting" }>;
  }
>): React.JSX.Element {
  const retryAt =
    statusSince === undefined
      ? undefined
      : statusSince + policy.delayMs(state.attempt);
  const due = retryAt === undefined ? 0 : retryAt - now;

  return (
    <Text size="sm" c="orange" data-testid="reconnect-status">
      {due > 0 ? `Retrying in ${formatRemaining(due)}` : "Retrying now"}{" "}
      (attempt {state.attempt} of {policy.maxAttempts}). Last failure:{" "}
      {state.reason}
    </Text>
  );
}

export function ConnectionHealth({
  state,
  statusSince,
  now,
  policy,
  health,
}: Readonly<ConnectionHealthProps>): React.JSX.Element | null {
  if (state.status === "reconnecting") {
    return (
      <ReconnectStatus
        state={state}
        statusSince={statusSince}
        now={now}
        policy={policy}
      />
    );
  }
  if (state.status !== "connected") {
    return null;
  }

  return (
    <Group align="flex-end" gap="md" mb="sm">
      <RttSparkline samples={health.samples} />
      {health.unresponsive && (
        <Text size="xs" c="dimmed">
          This node does not answer pings, so round trips are not measured
          automatically.
        </Text>
      )}
    </Group>
  );
}
