// A confirmation gate for gossip-driven peer discovery (wire-mesh#187): each row is one device this console's own gossip-expansion has surfaced from a connected node's directory but not yet dialled. Dialling a gossiped address unconditionally would be the same class of risk as a webpage probing a user's internal network (Private Network Access attacks) -- a lying peer in the directory could name an address that isn't a wire-mesh node at all -- so this console never auto-connects to one; every row waits here until this console's own user explicitly connects or dismisses it.

import { Button, Card, Group, Table, Text } from "@mantine/core";
import type { DeviceId } from "wire-mesh-core/generated/protocol";
import { deviceHex } from "./ConnectionPanel.js";
import { PeerLabel } from "./PeerLabel.js";

/** Where a discovered peer was learned of: the connection whose directory gossiped it, and, when that connection was itself reached by gossip, the device that vouched for it. */
export interface DiscoveredVia {
  /** The address the gossiping connection was dialled at. */
  address: string;
  /** Hex device-id of the node on that connection, when it is known. */
  device: string | undefined;
}

export interface DiscoveredPeerRow {
  key: string;
  device: DeviceId;
  addresses: readonly string[];
  via: DiscoveredVia;
}

export interface DiscoveredPeersPanelProps {
  peers: readonly DiscoveredPeerRow[];
  onConnect: (key: string) => void;
  onDismiss: (key: string) => void;
}

export function DiscoveredPeersPanel({
  peers,
  onConnect,
  onDismiss,
}: Readonly<DiscoveredPeersPanelProps>): React.JSX.Element | null {
  if (peers.length === 0) {
    return null;
  }
  return (
    <Card withBorder padding="md" radius="md" data-testid="discovered-peers">
      <Text fw={600} size="sm" mb="xs">
        Discovered peers
      </Text>
      <Text size="sm" c="dimmed" mb="xs">
        Each node below was listed in the directory of a node you are connected
        to, which is the only thing vouching for it: the address it lists may
        not be a wire-mesh node at all. Nothing is dialled until you connect.
      </Text>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>device</Table.Th>
            <Table.Th>addresses</Table.Th>
            <Table.Th>gossiped by</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {peers.map((peer) => (
            <Table.Tr key={peer.key}>
              <Table.Td>
                <PeerLabel deviceHex={deviceHex(peer.device)} />
              </Table.Td>
              <Table.Td>{peer.addresses.join(", ")}</Table.Td>
              <Table.Td>
                {peer.via.device !== undefined && (
                  <PeerLabel deviceHex={peer.via.device} />
                )}
                <Text size="xs" c="dimmed">
                  over {peer.via.address}
                </Text>
              </Table.Td>
              <Table.Td>
                <Group gap="xs">
                  <Button
                    size="xs"
                    onClick={() => {
                      onConnect(peer.key);
                    }}
                  >
                    Connect
                  </Button>
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    onClick={() => {
                      onDismiss(peer.key);
                    }}
                  >
                    Dismiss
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}
