// One open relay/hub connection's own UI: status line, ping/disconnect controls, peer directory, and frame log. All behaviour lives in wire-mesh-core's own mesh-session domain module; this component only renders whatever useMeshSessionEvents last reported and forwards clicks back onto the session.

import { Alert, Button, Card, Group, Table, Text } from "@mantine/core";
import type {
  MeshSession,
  SessionEvent,
} from "wire-mesh-core/domain/mesh-session";
import type { DeviceId } from "wire-mesh-core/generated/protocol";
import { useEffect, useRef, useState } from "react";
import { useMeshSessionEvents } from "../hooks/use-mesh-session-events.js";
import {
  browserPermissions,
  explainLocalNetworkBlock,
  type PermissionQuerier,
} from "../local-network.js";
import { usePeerNames } from "../hooks/use-peer-names.js";
import { selfNameExtension } from "../peer-names.js";
import { PeerLabel } from "./PeerLabel.js";

const HEX_RADIX = 16;

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

function describeFrame(frame: unknown): string {
  return JSON.stringify(frame, (_key: string, value: unknown): unknown =>
    value instanceof Uint8Array ? `<${String(value.byteLength)} bytes>` : value,
  );
}

export interface ConnectionPanelProps {
  address: string;
  session: Readonly<MeshSession>;
  onClose: () => void;
  onMessagePeer: (device: DeviceId) => void;
  /** The host of the page this panel is shown on, which decides whether reaching a local address needs the browser's permission. Defaults to the real page's. */
  pageHost?: string;
  /** Where to read the browser's permissions. Defaults to `navigator.permissions`, which a browser without the API leaves undefined. */
  permissions?: PermissionQuerier | undefined;
}

export function ConnectionPanel({
  address,
  session,
  onClose,
  onMessagePeer,
  pageHost = window.location.hostname,
  permissions = browserPermissions(),
}: Readonly<ConnectionPanelProps>): React.JSX.Element {
  const event = useMeshSessionEvents(session);
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

  return (
    <Card withBorder padding="md" radius="md">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>{address}</Text>
        <Group>
          <Button
            size="xs"
            disabled={event?.state.status !== "connected"}
            onClick={() => {
              void session.sendPing();
            }}
          >
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

      <Text fw={600} size="sm">
        Peer directory
      </Text>
      {directory.length === 0 ? (
        <Text size="sm" c="dimmed">
          No gossip received yet.
        </Text>
      ) : (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>device</Table.Th>
              <Table.Th>addresses</Table.Th>
              <Table.Th>snapshot (unix s)</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {directory.map((entry) => (
              <Table.Tr key={deviceHex(entry.device)}>
                <Table.Td>
                  <PeerLabel deviceHex={deviceHex(entry.device)} />
                </Table.Td>
                <Table.Td>{entry.advert.addresses.join(", ")}</Table.Td>
                <Table.Td>{entry.advert["snapshot-seconds"]}</Table.Td>
                <Table.Td>
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

      <Text fw={600} size="sm" mt="md">
        Frame log
      </Text>
      <Table.ScrollContainer minWidth={0} h={384}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>direction</Table.Th>
              <Table.Th>frame</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {frameLog.map((entry, index) => (
              <Table.Tr key={index}>
                <Table.Td>{entry.direction}</Table.Td>
                <Table.Td>{describeFrame(entry.frame)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
