// One open relay/hub connection's own UI: status line, ping/disconnect controls, peer directory, and frame log. All behaviour lives in wire-mesh-core's own mesh-session domain module; this component only renders whatever useMeshSessionEvents last reported and forwards clicks back onto the session.

import { Alert, Button, Card, Group, Text, Tooltip } from "@mantine/core";
import type {
  MeshSession,
  ReconnectPolicy,
  SessionEvent,
} from "wire-mesh-core/domain/mesh-session";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { DeviceId } from "wire-mesh-core/generated/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMeshSessionEvents } from "../hooks/use-mesh-session-events.js";
import {
  browserPermissions,
  explainLocalNetworkBlock,
  type PermissionQuerier,
} from "../local-network.js";
import { usePeerNames } from "../hooks/use-peer-names.js";
import { selfNameExtension } from "../peer-names.js";
import { useConnectionHealth } from "../hooks/use-connection-health.js";
import { useNow } from "../hooks/use-now.js";
import { certificateActivity } from "../activity.js";
import { formatAgo } from "../format-duration.js";
import { presentedCertificates } from "../certificate-trust.js";
import { toDialAddress } from "../dial-address.js";
import type { NodeCertificateChange } from "../hooks/use-certificate-trust.js";
import { ActivityLog } from "./ActivityLog.js";
import { ConnectionHealth } from "./ConnectionHealth.js";
import { PeerLabel } from "./PeerLabel.js";
import { StackedTable } from "./StackedTable.js";
import type { StackedColumn } from "./StackedTable.js";

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
  /** The host of the page this panel is shown on, which decides whether reaching a local address needs the browser's permission. Defaults to the real page's. */
  pageHost?: string;
  /** Where to read the browser's permissions. Defaults to `navigator.permissions`, which a browser without the API leaves undefined. */
  permissions?: PermissionQuerier | undefined;
}

/** How often elapsed times and the reconnect countdown refresh. */
const CLOCK_TICK_MS = 1000;

const DIRECTORY_COLUMNS: readonly StackedColumn[] = [
  { label: "device" },
  { label: "addresses" },
  { label: "advertised" },
  { label: "actions", headerless: true },
];

export function ConnectionPanel({
  address,
  session,
  clock,
  reconnectPolicy,
  certificateChanges,
  onClose,
  onMessagePeer,
  pageHost = window.location.hostname,
  permissions = browserPermissions(),
}: Readonly<ConnectionPanelProps>): React.JSX.Element {
  const {
    event,
    activity: sessionActivity,
    statusSince,
  } = useMeshSessionEvents(session, clock);
  const failing =
    event?.state.status === "reconnecting" || event?.state.status === "closed";
  // What the browser's answer was for one address; ignored once the connection is working again or the address is another.
  const [explained, setExplained] = useState<
    { address: string; message: string | undefined } | undefined
  >(undefined);
  useEffect(() => {
    // Set only while this effect is still current, so a slow answer cannot overwrite a newer one.
    const current = { value: true };
    if (failing) {
      void explainLocalNetworkBlock(address, pageHost, permissions).then(
        (message) => {
          if (current.value) {
            setExplained({ address, message });
          }
        },
      );
    }
    return () => {
      current.value = false;
    };
  }, [failing, address, pageHost, permissions]);
  const blocked =
    failing && explained?.address === address ? explained.message : undefined;
  const { observeDirectory, selfName } = usePeerNames();
  const connected = event?.state.status === "connected";
  useEffect(() => {
    if (event !== undefined) {
      observeDirectory(event.directory);
    }
  }, [event, observeDirectory]);
  // A session's initial self-advert carries no extensions, so this console's own display name is published by re-sending it once the link is up, and again whenever the name changes. Clearing the name re-sends the advert with no extensions, which is what retracts the earlier claim; that is only needed once a name has been published on this session.
  const namePublished = useRef(false);
  const [publishFailure, setPublishFailure] = useState<string | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!connected) return;
    if (selfName === undefined && !namePublished.current) return;
    namePublished.current = selfName !== undefined;
    session
      .sendGossipUpdate(
        selfName === undefined ? undefined : selfNameExtension(selfName),
      )
      .then(
        () => {
          setPublishFailure(undefined);
        },
        (error: unknown) => {
          setPublishFailure(
            error instanceof Error ? error.message : String(error),
          );
        },
      );
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
      {blocked === undefined ? null : (
        <Alert color="yellow" mb="sm">
          {blocked}
        </Alert>
      )}
      {publishFailure !== undefined && (
        <Alert color="red" title="Could not publish your display name" mb="sm">
          {publishFailure}
        </Alert>
      )}
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
        <StackedTable
          columns={DIRECTORY_COLUMNS}
          rows={directory.map((entry) => ({
            key: deviceHex(entry.device),
            cells: [
              <PeerLabel key="device" deviceHex={deviceHex(entry.device)} />,
              entry.advert.addresses.join(", "),
              <Tooltip
                key="advertised"
                label="As the peer advertised it, by its own clock"
              >
                <span>
                  {formatAgo(
                    now - entry.advert["snapshot-seconds"] * MS_PER_SECOND,
                  )}
                </span>
              </Tooltip>,
              <Button
                key="actions"
                size="xs"
                onClick={() => {
                  onMessagePeer(entry.device);
                }}
              >
                Message
              </Button>,
            ],
          }))}
        />
      )}

      <ActivityLog activity={activity} frameLog={frameLog} />
    </Card>
  );
}
