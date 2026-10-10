// A confirmation gate for gossip-driven peer discovery (wire-mesh#187): each row is one device this console's own gossip-expansion has surfaced from a connected node's directory but not yet dialled. Dialling a gossiped address unconditionally would be the same class of risk as a webpage probing a user's internal network (Private Network Access attacks) -- a lying peer in the directory could name an address that isn't a wire-mesh node at all -- so this console never auto-connects to one; every row waits here until this console's own user explicitly connects or dismisses it.

import { Fragment } from "react";
import { Button, Card, Group, Text } from "@mantine/core";
import type { DeviceId } from "wire-mesh-core/generated/protocol";
import { deviceHex } from "./ConnectionPanel.js";
import { PeerLabel } from "./PeerLabel.js";
import { StackedTable } from "./StackedTable.js";
import type { StackedColumn } from "./StackedTable.js";

/** Where a discovered peer was learned of: the connection whose directory gossiped it, and, when that connection was itself reached by gossip, the device the gossip claimed lives at its address. */
export interface DiscoveredVia {
  /** The address the gossiping connection was dialled at. */
  address: string;
  /** Hex device-id a gossiping node claimed for the address that connection was dialled at. Nothing on the connection authenticates it, so it is shown as a claim, never as who answered. */
  claimedDevice: string | undefined;
}

export interface DiscoveredPeerRow {
  key: string;
  device: DeviceId;
  addresses: readonly string[];
  via: DiscoveredVia;
}

const COLUMNS: readonly StackedColumn[] = [
  { label: "device" },
  { label: "addresses" },
  { label: "gossiped by" },
  { label: "actions", headerless: true },
];

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
      <StackedTable
        columns={COLUMNS}
        rows={peers.map((peer) => ({
          key: peer.key,
          cells: [
            <PeerLabel key="device" deviceHex={deviceHex(peer.device)} />,
            peer.addresses.join(", "),
            <Fragment key="via">
              {peer.via.claimedDevice !== undefined && (
                <>
                  <Text size="xs" c="dimmed">
                    claimed to be
                  </Text>
                  <PeerLabel deviceHex={peer.via.claimedDevice} />
                </>
              )}
              <Text size="xs" c="dimmed">
                over {peer.via.address}
              </Text>
            </Fragment>,
            <Group key="actions" gap="xs">
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
            </Group>,
          ],
        }))}
      />
    </Card>
  );
}
