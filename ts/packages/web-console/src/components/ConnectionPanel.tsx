// One open relay/hub connection's own UI: status line, ping/disconnect controls, peer directory, and frame log. All behaviour lives in wire-mesh-core's own mesh-session domain module; this component only renders whatever useMeshSessionEvents last reported and forwards clicks back onto the session.

import { Button, Card, Group, Table, Text, Tooltip } from "@mantine/core";
import type {
  MeshSession,
  ReconnectPolicy,
  SessionEvent,
} from "wire-mesh-core/domain/mesh-session";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { DeviceId } from "wire-mesh-core/generated/protocol";
import { useEffect, useMemo } from "react";
import { useMeshSessionEvents } from "../hooks/use-mesh-session-events.js";
import { usePeerNames } from "../hooks/use-peer-names.js";
import { selfNameExtension } from "../peer-names.js";
import { useConnectionHealth } from "../hooks/use-connection-health.js";
import { useNow } from "../hooks/use-now.js";
import { certificateActivity } from "../activity.js";
import { formatAgo } from "../format-duration.js";
import { presentedCertificates } from "../certificate-trust.js";
import { toDialAddress } from "../dial-address.js";
import type { NodeCertificateChange } from "../hooks/use-certificate-trust.js";
import { stackedTable } from "../App.css.js";
import { ActivityLog } from "./ActivityLog.js";
import { ConnectionHealth } from "./ConnectionHealth.js";
import { PeerLabel } from "./PeerLabel.js";

const HEX_RADIX = 16;
const MS_PER_SECOND = 1000;

export function deviceHex(device: Uint8Array): string {
  let hex = "";
  for (const byte of device) {
    hex += byte.toString(HEX_RADIX).padStart(2, "0");
  }
  return hex;
}

function describeHandshake(event: Readonly<SessionEvent>): string {
  if (event.state.status !== "connected") {
    return "";
  }
  switch (event.state.handshake.status) {
    case "pending":
      return " · handshake pending";
    case "negotiated":
      return ` · v${String(event.state.handshake.version)} · ${event.state.handshake.sharedDomains.join(", ")}`;
    case "unanswered":
      return " · handshake unanswered (relay-only node?)";
    case "rejected":
      return ` · handshake rejected (${event.state.handshake.reason})`;
  }
  return "";
}

function describeStatus(event: Readonly<SessionEvent>): string {
  const { state } = event;
  switch (state.status) {
    case "connecting":
      return "connecting…";
    case "connected":
      return `connected${describeHandshake(event)}`;
    case "reconnecting":
      return `reconnecting (attempt ${String(state.attempt)}, ${state.reason})…`;
    case "closed":
      return `closed (${state.reason})`;
    case "idle":
      return "idle";
  }
  return "";
}

export interface ConnectionPanelProps {
  address: string;
  session: Readonly<MeshSession>;
  clock: Readonly<Clock>;
  /** The backoff the session redials with, so the panel can say when the next attempt is due. */
  reconnectPolicy: Readonly<ReconnectPolicy>;
  /** Every certificate change seen for any node; the panel shows those for its own node in its activity. */
  certificateChanges: readonly NodeCertificateChange[];
  onClose: () => void;
  onMessagePeer: (device: DeviceId) => void;
}

/** How often elapsed times and the reconnect countdown refresh. */
const CLOCK_TICK_MS = 1000;

export function ConnectionPanel({
  address,
  session,
  clock,
  reconnectPolicy,
  certificateChanges,
  onClose,
  onMessagePeer,
}: Readonly<ConnectionPanelProps>): React.JSX.Element {
  const {
    event,
    activity: sessionActivity,
    statusSince,
  } = useMeshSessionEvents(session, clock);
  const { observeDirectory, selfName } = usePeerNames();
  const connected = event?.state.status === "connected";
  useEffect(() => {
    if (event !== undefined) {
      observeDirectory(event.directory);
    }
  }, [event, observeDirectory]);
  // A session's initial self-advert carries no extensions, so this console's own display name is published by re-sending it once the link is up, and again whenever the name changes.
  useEffect(() => {
    if (connected && selfName !== undefined) {
      session.sendGossipUpdate(selfNameExtension(selfName)).catch(() => {
        // The link dropped between the status read and the send; this effect runs again when the session reconnects, which republishes the name.
      });
    }
  }, [connected, selfName, session]);
  const status = event === undefined ? "idle" : describeStatus(event);
  const directory = event?.directory ?? [];
  const frameLog = event?.frameLog ?? [];
  const health = useConnectionHealth(session, connected);
  const reconnecting = event?.state.status === "reconnecting";
  const now = useNow(
    clock,
    reconnecting || directory.length > 0,
    CLOCK_TICK_MS,
  );
  const node = presentedCertificates(toDialAddress(address))?.node;
  const activity = useMemo(
    () =>
      [
        ...sessionActivity,
        ...certificateActivity(
          certificateChanges.filter((change) => change.node === node),
        ),
      ].sort((a, b) => a.at - b.at),
    [sessionActivity, certificateChanges, node],
  );

  return (
    <Card withBorder padding="md" radius="md">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>{address}</Text>
        <Group>
          <Button size="xs" disabled={!connected} onClick={health.probe}>
            Send ping
          </Button>
          <Button size="xs" color="red" variant="light" onClick={onClose}>
            Disconnect
          </Button>
        </Group>
      </Group>
      <Text fw={600} size="sm" mb="sm">
        {status}
      </Text>
      {event !== undefined && (
        <ConnectionHealth
          state={event.state}
          statusSince={statusSince}
          now={now}
          policy={reconnectPolicy}
          health={health}
        />
      )}

      <Text fw={600} size="sm">
        Peer directory
      </Text>
      {directory.length === 0 ? (
        <Text size="sm" c="dimmed">
          No gossip received yet.
        </Text>
      ) : (
        <Table striped className={stackedTable}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>device</Table.Th>
              <Table.Th>addresses</Table.Th>
              <Table.Th>last seen</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {directory.map((entry) => (
              <Table.Tr key={deviceHex(entry.device)}>
                <Table.Td data-label="device">
                  <PeerLabel deviceHex={deviceHex(entry.device)} />
                </Table.Td>
                <Table.Td data-label="addresses">
                  {entry.advert.addresses.join(", ")}
                </Table.Td>
                <Table.Td data-label="last seen">
                  <Tooltip label="As the peer advertised it, by its own clock">
                    <span>
                      {formatAgo(
                        now - entry.advert["snapshot-seconds"] * MS_PER_SECOND,
                      )}
                    </span>
                  </Tooltip>
                </Table.Td>
                <Table.Td data-label="actions">
                  <Button
                    size="xs"
                    onClick={() => {
                      onMessagePeer(entry.device);
                    }}
                  >
                    Message
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <ActivityLog activity={activity} frameLog={frameLog} />
    </Card>
  );
}
