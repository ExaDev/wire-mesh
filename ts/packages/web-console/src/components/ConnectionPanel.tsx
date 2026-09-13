// One open relay/hub connection's own UI: status line, ping/disconnect controls, peer directory, and frame log. All behaviour lives in wire-mesh-core's own mesh-session domain module; this component only renders whatever useMeshSessionEvents last reported and forwards clicks back onto the session.

import { Button, Card, Group, Table, Text } from "@mantine/core";
import type {
  MeshSession,
  SessionEvent,
} from "wire-mesh-core/domain/mesh-session";
import { useMeshSessionEvents } from "../hooks/use-mesh-session-events.js";

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
    value instanceof Uint8Array
      ? `<${String(value.byteLength)} bytes>`
      : value,
  );
}

export interface ConnectionPanelProps {
  address: string;
  session: Readonly<MeshSession>;
  onClose: () => void;
}

export function ConnectionPanel({
  address,
  session,
  onClose,
}: Readonly<ConnectionPanelProps>): React.JSX.Element {
  const event = useMeshSessionEvents(session);
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
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {directory.map((entry) => (
              <Table.Tr key={deviceHex(entry.device)}>
                <Table.Td>{deviceHex(entry.device)}</Table.Td>
                <Table.Td>{entry.advert.addresses.join(", ")}</Table.Td>
                <Table.Td>{entry.advert["snapshot-seconds"]}</Table.Td>
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
