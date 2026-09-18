// Top-level layout: the connect form, the list of currently open relay connection panels, and every peer-to-peer room-messaging panel. Owns only the set of live sessions and negotiators -- everything about rendering one relay session's own state lives in ConnectionPanel, and everything about a room session's own state lives in the useRoomMessaging hook plus RoomPanel.

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Group,
  Stack,
  TextInput,
  Title,
} from "@mantine/core";
import { createMeshSession } from "wire-mesh-core/domain/mesh-session";
import type {
  MeshSession,
  ReconnectPolicy,
} from "wire-mesh-core/domain/mesh-session";
import { createGossipExpansion } from "wire-mesh-core/domain/gossip-expansion";
import type {
  GossipExpansion,
  GossipExpansionCandidate,
} from "wire-mesh-core/domain/gossip-expansion";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { DeviceId } from "wire-mesh-core/generated/protocol";
import { createBrowserTransport } from "./adapters/websocket-transport.js";
import { createWebrtcNegotiator } from "./webrtc-negotiation.js";
import type { WebrtcNegotiator } from "./webrtc-negotiation.js";
import { ConnectionPanel, deviceHex } from "./components/ConnectionPanel.js";
import { DiscoveredPeersPanel } from "./components/DiscoveredPeersPanel.js";
import type { DiscoveredPeerRow } from "./components/DiscoveredPeersPanel.js";
import { RoomPanel } from "./components/RoomPanel.js";
import { useRoomMessaging } from "./hooks/use-room-messaging.js";
import type { MessageStore } from "./message-store.js";
import { discoverLocalNode as discoverLocalNodeDefault } from "./discover-local-node.js";
import { appShell } from "./App.css.js";

export interface AppProps {
  identity: IdentityPort;
  clock: Clock;
  messageStore: MessageStore;
  /** Attempts same-device node auto-discovery once, on mount. Defaults to the real `discoverLocalNode` (a no-op when this console is served from a loopback origin, a real localhost probe otherwise); tests inject a fake to avoid depending on `location`/`fetch`. */
  discoverLocalNode?: () => Promise<string | undefined>;
  // Seeds the Node field. Left as a prop (rather than App reading location/import.meta.env itself) so App stays the plain, testable component its own header comment describes; main.tsx computes the real value via default-hub-address.ts.
  defaultAddress?: string;
}

const DEFAULT_ADDRESS = "ws://localhost:8787";
const AVAILABLE_DOMAINS = ["core/management", "core/exec", "core/data"];
const DEFAULT_DOMAINS = ["core/management", "core/data"];

// Exponential backoff, capped at 30s, giving up after 5 attempts -- reasonable defaults for a browser console reconnecting to a relay that may just be restarting, without retrying forever against one that is genuinely gone.
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_BASE = 2;
const reconnectPolicy: ReconnectPolicy = {
  maxAttempts: RECONNECT_MAX_ATTEMPTS,
  delayMs: (attempt) =>
    Math.min(
      RECONNECT_BASE_DELAY_MS * RECONNECT_BACKOFF_BASE ** (attempt - 1),
      RECONNECT_MAX_DELAY_MS,
    ),
};

interface ConnectionEntry {
  address: string;
  session: ReturnType<typeof createMeshSession>;
  negotiator: WebrtcNegotiator;
}

/** A discovered candidate awaiting this console user's own explicit connect/dismiss (wire-mesh#187) -- resolve is createGossipExpansion's own shouldExpand promise, settled by whichever button the user clicks in DiscoveredPeersPanel. */
interface PendingExpansion extends DiscoveredPeerRow {
  resolve: (approved: boolean) => void;
}

/** Gossiped addresses are bare "host:port" (wire-mesh#38's own convention -- see mesh-session.ts's addresses doc comment), but this console's browser transport only accepts a full ws:// or wss:// URL. A caller-typed address in the connect form may already carry a scheme (the default address is "ws://localhost:8787"); a gossiped one never does. */
function toWebSocketAddress(address: string): string {
  return address.startsWith("ws://") || address.startsWith("wss://")
    ? address
    : `ws://${address}`;
}

export function App({
  identity,
  clock,
  messageStore,
  discoverLocalNode = discoverLocalNodeDefault,
  defaultAddress = DEFAULT_ADDRESS,
}: Readonly<AppProps>): React.JSX.Element {
  const [address, setAddress] = useState(defaultAddress);
  const [domains, setDomains] = useState<string[]>(DEFAULT_DOMAINS);
  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const [discovered, setDiscovered] = useState<PendingExpansion[]>([]);
  const roomMessaging = useRoomMessaging(identity, clock, messageStore);

  // A negotiator's own onIncomingConnection callback is registered once, at construction, and must still call whatever the *latest* attach is -- attach itself is a fresh function every time useRoomMessaging's own session map changes, so a ref (updated every render, read from the callback) is what keeps that call from closing over a stale, since-superseded attach.
  const attachRef = useRef(roomMessaging.attach);
  useEffect(() => {
    attachRef.current = roomMessaging.attach;
  }, [roomMessaging.attach]);

  // connectTo/connectionsRef exist so both the manual connect form and the mount-time auto-discovery effect below share one connection path -- connectionsRef mirrors `connections` state so connectTo's duplicate-address check (and the effect calling it) always sees the latest entries without depending on `connections` itself and re-running on every connection change.
  const connectionsRef = useRef(connections);
  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);

  // The current domains value, read from a ref rather than closed over directly -- dialExpanded/createExpandableSession are invoked from callbacks createGossipExpansion holds onto for as long as a given session's own gossip directory keeps discovering new peers, well outliving any single render, and must still dial with whatever domains the connect form currently offers, not whichever were selected when that session's own expansion was first wired up.
  const domainsRef = useRef(domains);
  useEffect(() => {
    domainsRef.current = domains;
  }, [domains]);

  function attachConnection(entryAddress: string, session: MeshSession): void {
    const negotiator = createWebrtcNegotiator(session, {
      identity,
      clock,
      onIncomingConnection: (connection: Readonly<Connection>) => {
        void attachRef.current(connection);
      },
    });
    setConnections((current) => [
      ...current,
      { address: entryAddress, session, negotiator },
    ]);
  }

  /** Asks this console's own user whether to dial a gossiped candidate at all (wire-mesh#187) -- the explicit-confirmation half of the issue's own two named options, since this console holds no persistent device-trust store a gateway_trust-style allow-list could check instead. Resolves once the user clicks Connect or Dismiss in DiscoveredPeersPanel. */
  async function confirmExpansion(
    candidate: Readonly<GossipExpansionCandidate>,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      setDiscovered((current) => [
        ...current,
        {
          key: deviceHex(candidate.device),
          device: candidate.device,
          addresses: candidate.addresses,
          resolve,
        },
      ]);
    });
  }

  function resolveDiscovered(key: string, approved: boolean): void {
    setDiscovered((current) => {
      current.find((entry) => entry.key === key)?.resolve(approved);
      return current.filter((entry) => entry.key !== key);
    });
  }

  /** Builds a session wired to attempt direct connections to its own gossip directory's newly-discovered peers (wire-mesh#187's "discover once connected, expand outward"), confirmed by this console's own user first. Every expansion-dialled session gets the identical wiring in turn, so discovery keeps expanding outward through however many hops of directly-reachable peers actually exist -- not just the one node dialled first, and not just its own immediate peers. */
  function createExpandableSession(): MeshSession {
    const expansionRef: { current: GossipExpansion | null } = {
      current: null,
    };
    const session = createMeshSession(
      createBrowserTransport(),
      identity,
      clock,
      reconnectPolicy,
      [],
      (advert) => {
        expansionRef.current?.considerAdvert(advert);
      },
    );
    expansionRef.current = createGossipExpansion({
      selfDeviceId: identity.deviceId,
      shouldExpand: confirmExpansion,
      dial: dialExpanded,
      onExpanded: (_candidate, expandedAddress, expandedSession) => {
        attachConnection(expandedAddress, expandedSession);
      },
      // A dial that never got user approval (onExpansionDeclined) or that failed against every one of its addresses (onExpansionFailed) simply never produces a session -- there is no panel to remove and nothing further for this console to do, matching how a manually-typed address that fails to connect leaves no panel behind either.
    });
    return session;
  }

  async function dialExpanded(gossipedAddress: string): Promise<MeshSession> {
    const session = createExpandableSession();
    return session
      .connect(toWebSocketAddress(gossipedAddress), domainsRef.current)
      .then(() => session);
  }

  function connectTo(targetAddress: string): void {
    // Re-connecting to an address that already has a live entry is a no-op: an entry is removed either by its own panel's close button, or automatically when its connect attempt fails, so reconnecting the same address after a failure starts a fresh attempt, but reconnecting while still connecting/connected/reconnecting is a no-op rather than a silent duplicate.
    if (
      connectionsRef.current.some((entry) => entry.address === targetAddress)
    ) {
      return;
    }
    const session = createExpandableSession();
    attachConnection(targetAddress, session);
    void session.connect(targetAddress, domains).catch(() => {
      // ConnectionPanel's own render of the session's events already surfaces a connect failure via its status line; nothing further to do here beyond letting the entry remain (its own close button still works on a failed session).
    });
  }

  // discoverLocalNode is a fresh closure every render (or a caller-supplied fake in tests), so the mount-only effect below reads it through a ref (the same pattern attachRef already uses above) rather than listing it as an effect dependency, which would either re-run the probe every render or need a lint suppression. connectTo is a plain function, recreated every render like attachConnection/createExpandableSession above it -- its own ref-update effect below simply runs every render too, which is cheap and still gives the mount effect the latest version by the time it actually fires.
  const connectToRef = useRef(connectTo);
  useEffect(() => {
    connectToRef.current = connectTo;
  });
  const discoverLocalNodeRef = useRef(discoverLocalNode);
  useEffect(() => {
    discoverLocalNodeRef.current = discoverLocalNode;
  }, [discoverLocalNode]);

  // Runs exactly once per mount: a ref guard (rather than an empty dependency array alone) survives React StrictMode's deliberate double-invoke of effects in development, so a same-device node never gets probed or dialled twice.
  const autoDiscoverRanRef = useRef(false);
  useEffect(() => {
    if (autoDiscoverRanRef.current) return;
    autoDiscoverRanRef.current = true;
    void discoverLocalNodeRef.current().then((discoveredAddress) => {
      if (discoveredAddress !== undefined) {
        connectToRef.current(discoveredAddress);
      }
    });
  }, []);

  function handleSubmit(event: React.SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    connectTo(address);
  }

  function handleClose(target: Readonly<ConnectionEntry>): void {
    void target.session.close();
    setConnections((current) =>
      current.filter((entry) => entry.session !== target.session),
    );
  }

  function handleMessagePeer(
    negotiator: Readonly<WebrtcNegotiator>,
    device: DeviceId,
  ): void {
    negotiator
      .initiate(device)
      .then(async (connection) => roomMessaging.attach(connection, device))
      .catch(() => {
        // RoomPanel only ever renders once a session actually attaches; a negotiation failure (ICE never completing, the peer refusing) simply means no panel appears -- nothing else in this console currently surfaces a connect failure more specifically than that.
      });
  }

  return (
    <Stack className={appShell} p="md" gap="lg">
      <Title order={1}>wire-mesh console</Title>
      <form onSubmit={handleSubmit}>
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label="Node"
            value={address}
            onChange={(event) => {
              setAddress(event.currentTarget.value);
            }}
            required
            style={{ flex: 1, minWidth: "16rem" }}
          />
          <Button type="submit">Connect</Button>
        </Group>
        <Checkbox.Group
          label="Domains offered"
          value={domains}
          onChange={setDomains}
        >
          <Group mt="xs">
            {AVAILABLE_DOMAINS.map((domain) => (
              <Checkbox key={domain} value={domain} label={domain} />
            ))}
          </Group>
        </Checkbox.Group>
      </form>
      <DiscoveredPeersPanel
        peers={discovered}
        onConnect={(key) => {
          resolveDiscovered(key, true);
        }}
        onDismiss={(key) => {
          resolveDiscovered(key, false);
        }}
      />
      {connections.map((entry) => (
        <ConnectionPanel
          key={entry.address}
          address={entry.address}
          session={entry.session}
          onClose={() => {
            handleClose(entry);
          }}
          onMessagePeer={(device) => {
            handleMessagePeer(entry.negotiator, device);
          }}
        />
      ))}
      {roomMessaging.sessions.map((view) => (
        <RoomPanel
          key={view.peerHex}
          view={view}
          onSend={async (text) => roomMessaging.send(view.peerHex, text)}
          onPostNotice={async (text) =>
            roomMessaging.postNotice(view.peerHex, text)
          }
        />
      ))}
    </Stack>
  );
}
