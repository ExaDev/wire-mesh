// Top-level layout: the connect form, the list of currently open relay connection panels, and every peer-to-peer room-messaging panel. Owns only the set of live sessions and negotiators -- everything about rendering one relay session's own state lives in ConnectionPanel, and everything about a room session's own state lives in the useRoomMessaging hook plus RoomPanel.

import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Stack,
  TextInput,
  Title,
} from "@mantine/core";
import { createMeshSession } from "wire-mesh-core/domain/mesh-session";
import type { MeshSession } from "wire-mesh-core/domain/mesh-session";
import { createGossipExpansion } from "wire-mesh-core/domain/gossip-expansion";
import type {
  GossipExpansion,
  GossipExpansionCandidate,
} from "wire-mesh-core/domain/gossip-expansion";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { DeviceId } from "wire-mesh-core/generated/protocol";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { dmRoomPath } from "wire-mesh-core/domain/room-path";
import { reconnectPolicy } from "./reconnect-policy.js";
import { createDialTransport } from "./adapters/dial-transport.js";
import type { CertificateMemory } from "./certificate-memory.js";
import { DEFAULT_ICE_SERVERS } from "./ice-servers.js";
import { createWebrtcNegotiator } from "./webrtc-negotiation.js";
import type { WebrtcNegotiator } from "./webrtc-negotiation.js";
import { ConnectionPanel, deviceHex } from "./components/ConnectionPanel.js";
import { DiscoveredPeersPanel } from "./components/DiscoveredPeersPanel.js";
import type {
  DiscoveredPeerRow,
  DiscoveredVia,
} from "./components/DiscoveredPeersPanel.js";
import { CertificateTrustPanel } from "./components/CertificateTrustPanel.js";
import { useCertificateTrust } from "./hooks/use-certificate-trust.js";
import { PeerNamesProvider } from "./components/PeerNamesProvider.js";
import { PeerName } from "./components/PeerName.js";
import { SelfNameField } from "./components/SelfNameField.js";
import { OnboardingIntro } from "./components/OnboardingIntro.js";
import { SearchPanel } from "./components/SearchPanel.js";
import { useIntro } from "./hooks/use-intro.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { NameStore } from "./name-store.js";
import { ConversationList } from "./components/ConversationList.js";
import { RoomPanel } from "./components/RoomPanel.js";
import { useRoomMessaging } from "./hooks/use-room-messaging.js";
import { createRequestDemux } from "./request-demux.js";
import { ROOM_MEMBER_CAPABILITY } from "wire-mesh-core/domain/room-token-verification";
import { WEBRTC_SIGNAL_VERB } from "wire-mesh-core/domain/webrtc-signaling";
import type { MessageStore } from "./message-store.js";
import { discoverLocalNode as discoverLocalNodeDefault } from "./discover-local-node.js";
import { appShell } from "./App.css.js";
import { toDialAddress } from "./dial-address.js";

export interface AppProps {
  identity: IdentityPort;
  clock: Clock;
  messageStore: MessageStore;
  /** What each node last announced about the certificates it serves, so a node's address keeps working as its certificates change. */
  certificateMemory: CertificateMemory;
  /** The petnames this viewer has given peers and this console's own display name, kept in the console's own storage. */
  nameStore: NameStore;
  /** Interface preferences kept in the console's own storage, such as whether the first-run intro has been dismissed. */
  preferences: PreferencesStore;
  /** Attempts same-device node auto-discovery once, on mount. Defaults to the real `discoverLocalNode` (a no-op when this console is served from a loopback origin, a real localhost probe otherwise); tests inject a fake to avoid depending on `location`/`fetch`. */
  discoverLocalNode?: () => Promise<string | undefined>;
  // Seeds the Node field. Left as a prop (rather than App reading location/import.meta.env itself) so App stays the plain, testable component its own header comment describes; main.tsx computes the real value via default-hub-address.ts.
  defaultAddress?: string;
}

const DEFAULT_ADDRESS = "ws://localhost:8787";
const AVAILABLE_DOMAINS = ["core/management", "core/exec", "core/data"];
const DEFAULT_DOMAINS = ["core/management", "core/data"];

/** A direct connection attempt that did not open, kept on screen until dismissed so a refusal or a failure to negotiate is never silent. The conversation itself carries on through the hub. */
interface ConnectionFailure {
  key: string;
  peer: string;
  reason: string;
}

interface ConnectionEntry {
  address: string;
  session: ReturnType<typeof createMeshSession>;
  negotiator: WebrtcNegotiator;
}

/** The room verb and the WebRTC signalling verb, the two a hub connection's incoming requests are split between. */
const HUB_VERBS = [WEBRTC_SIGNAL_VERB, ROOM_MEMBER_CAPABILITY];

/** A discovered candidate awaiting this console user's own explicit connect/dismiss (wire-mesh#187) -- resolve is createGossipExpansion's own shouldExpand promise, settled by whichever button the user clicks in DiscoveredPeersPanel. */
interface PendingExpansion extends DiscoveredPeerRow {
  resolve: (approved: boolean) => void;
}

export function App({
  identity,
  clock,
  messageStore,
  certificateMemory,
  nameStore,
  preferences,
  discoverLocalNode = discoverLocalNodeDefault,
  defaultAddress = DEFAULT_ADDRESS,
}: Readonly<AppProps>): React.JSX.Element {
  const [address, setAddress] = useState(defaultAddress);
  const [domains, setDomains] = useState<string[]>(DEFAULT_DOMAINS);
  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const [discovered, setDiscovered] = useState<PendingExpansion[]>([]);
  const [failures, setFailures] = useState<ConnectionFailure[]>([]);
  const intro = useIntro(preferences);
  const trust = useCertificateTrust(certificateMemory, clock);
  const roomMessaging = useRoomMessaging(identity, clock, messageStore);
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  // The conversation shown is the one the user picked, falling back to the first while nothing is picked or the picked one no longer exists.
  const selectedConversation =
    roomMessaging.conversations.find(
      (conversation) => conversation.roomPath === selectedPath,
    ) ?? roomMessaging.conversations[0];

  // Whatever conversation is on screen has its messages read as they arrive.
  const { markRead } = roomMessaging;
  const selectedRoomPath = selectedConversation?.roomPath;
  const selectedUnread = selectedConversation?.unread ?? 0;
  useEffect(() => {
    if (selectedRoomPath !== undefined && selectedUnread > 0) {
      markRead(selectedRoomPath);
    }
  }, [selectedRoomPath, selectedUnread, markRead]);

  // A negotiator's own onIncomingConnection callback is registered once, at construction, and must still call whatever the *latest* attach is -- attach itself is a fresh function every time useRoomMessaging's own session map changes, so a ref (updated every render, read from the callback) is what keeps that call from closing over a stale, since-superseded attach.
  const watchHubRef = useRef(roomMessaging.watchHub);
  useEffect(() => {
    watchHubRef.current = roomMessaging.watchHub;
  }, [roomMessaging.watchHub]);

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
  // Addresses of this console's own connect attempts still waiting on a certificate decision, and the device a gossiping node claimed for each address this console has offered to dial and not yet dialled or given up on.
  const confirmingRef = useRef(new Set<string>());
  const claimedDevices = useRef(new Map<string, string>());
  // Set once the console is closed, so a certificate decision or dial that settles afterwards opens nothing.
  const closedRef = useRef(false);
  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
    };
  }, []);
  const domainsRef = useRef(domains);
  useEffect(() => {
    domainsRef.current = domains;
  }, [domains]);

  function attachConnection(entryAddress: string, session: MeshSession): void {
    // The session's stream of incoming requests has one backlog, so the negotiator and the conversations reached through this hub share it through a demux instead of racing to read it.
    const demux = createRequestDemux(session.incomingManageRequests, HUB_VERBS);
    const negotiator = createWebrtcNegotiator(
      {
        sendManageRequest: async (...args) =>
          session.sendManageRequest(...args),
        incomingManageRequests: demux.stream(WEBRTC_SIGNAL_VERB),
      },
      {
        identity,
        clock,
        iceServers: DEFAULT_ICE_SERVERS,
        onIncomingConnection: (connection: Readonly<Connection>) => {
          void attachRef.current(connection);
        },
      },
    );
    watchHubRef.current({
      sendManageRequest: async (...args) => session.sendManageRequest(...args),
      incomingManageRequests: demux.stream(ROOM_MEMBER_CAPABILITY),
    });
    setConnections((current) => [
      ...current,
      { address: entryAddress, session, negotiator },
    ]);
  }

  /** Asks this console's own user whether to dial a gossiped candidate at all (wire-mesh#187) -- the explicit-confirmation half of the issue's own two named options, since this console holds no persistent device-trust store a gateway_trust-style allow-list could check instead. Resolves once the user clicks Connect or Dismiss in DiscoveredPeersPanel. */
  async function confirmExpansion(
    candidate: Readonly<GossipExpansionCandidate>,
    via: Readonly<DiscoveredVia>,
  ): Promise<boolean> {
    const key = deviceHex(candidate.device);
    // The connection made through a gossiped address authenticates nothing about which device answers, so the device the gossip named is kept only to show as a claim beside what that connection gossips in turn.
    for (const candidateAddress of candidate.addresses) {
      claimedDevices.current.set(candidateAddress, key);
    }
    return new Promise<boolean>((resolve) => {
      setDiscovered((current) => [
        ...current,
        {
          key,
          device: candidate.device,
          addresses: candidate.addresses,
          via,
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
  function createExpandableSession(via: Readonly<DiscoveredVia>): MeshSession {
    const expansionRef: { current: GossipExpansion | null } = {
      current: null,
    };
    const session = createMeshSession(
      createDialTransport(trust.memory),
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
      shouldExpand: async (candidate) => confirmExpansion(candidate, via),
      dial: dialExpanded,
      onExpanded: (_candidate, expandedAddress, expandedSession) => {
        attachConnection(expandedAddress, expandedSession);
      },
      // A dial that never got user approval (onExpansionDeclined) or that failed against every one of its addresses (onExpansionFailed) simply never produces a session -- there is no panel to remove and nothing further for this console to do, matching how a manually-typed address that fails to connect leaves no panel behind either. Either way the claims kept for its addresses are no longer needed.
      onExpansionDeclined: forgetClaims,
      onExpansionFailed: forgetClaims,
    });
    return session;
  }

  function forgetClaims(candidate: Readonly<GossipExpansionCandidate>): void {
    for (const candidateAddress of candidate.addresses) {
      claimedDevices.current.delete(candidateAddress);
    }
  }

  async function dialExpanded(gossipedAddress: string): Promise<MeshSession> {
    const dialAddress = await trust.confirmAddress(
      toDialAddress(gossipedAddress),
    );
    if (dialAddress === undefined) {
      throw new Error(`the certificate of ${gossipedAddress} was not trusted`);
    }
    if (closedRef.current) {
      throw new Error("the console was closed before the dial began");
    }
    const claimedDevice = claimedDevices.current.get(gossipedAddress);
    claimedDevices.current.delete(gossipedAddress);
    const session = createExpandableSession({
      address: gossipedAddress,
      claimedDevice,
    });
    return session.connect(dialAddress, domainsRef.current).then(() => session);
  }

  function connectTo(targetAddress: string): void {
    // Re-connecting to an address that already has a live entry is a no-op: an entry is removed either by its own panel's close button, or automatically when its connect attempt fails, so reconnecting the same address after a failure starts a fresh attempt, but reconnecting while still connecting/connected/reconnecting is a no-op rather than a silent duplicate.
    if (
      connectionsRef.current.some((entry) => entry.address === targetAddress)
    ) {
      return;
    }
    // The same address submitted again while its certificate is awaiting a decision is the same attempt, not a second one.
    if (confirmingRef.current.has(targetAddress)) {
      return;
    }
    confirmingRef.current.add(targetAddress);
    void trust
      .confirmAddress(toDialAddress(targetAddress))
      .then((dialAddress) => {
        if (dialAddress === undefined || closedRef.current) {
          return;
        }
        const session = createExpandableSession({
          address: targetAddress,
          claimedDevice: undefined,
        });
        attachConnection(targetAddress, session);
        void session.connect(dialAddress, domains).catch(() => {
          // ConnectionPanel's own render of the session's events already surfaces a connect failure via its status line; nothing further to do here beyond letting the entry remain (its own close button still works on a failed session).
        });
      })
      .finally(() => {
        confirmingRef.current.delete(targetAddress);
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
    roomMessaging.dropHub(target.session);
    void target.session.close();
    setConnections((current) =>
      current.filter((entry) => entry.session !== target.session),
    );
  }

  function handleMessagePeer(
    entry: Readonly<ConnectionEntry>,
    device: DeviceId,
  ): void {
    // The conversation opens at once over the hub the peer was found through, and a direct connection is negotiated in the background: it takes over when it opens, and its failure costs nothing but the direct route.
    roomMessaging.openRelay(entry.session, device);
    setSelectedPath(
      dmRoomPath(deviceIdToHex(identity.deviceId), deviceIdToHex(device)),
    );
    entry.negotiator
      .initiate(device)
      .then(async (connection) => roomMessaging.attach(connection, device))
      .catch((error: unknown) => {
        setFailures((current) => [
          ...current,
          {
            key: crypto.randomUUID(),
            peer: deviceHex(device),
            reason: error instanceof Error ? error.message : String(error),
          },
        ]);
      });
  }

  return (
    <PeerNamesProvider store={nameStore}>
      <Stack className={appShell} p="md" gap="lg">
        <Group justify="space-between">
          <Title order={1}>wire-mesh console</Title>
          {intro.ready && !intro.visible && (
            <Button size="xs" variant="subtle" onClick={intro.show}>
              How this works
            </Button>
          )}
        </Group>
        {intro.error !== undefined && (
          <Alert
            color="red"
            title="The first-run intro's setting is unavailable"
          >
            {intro.error}
          </Alert>
        )}
        {intro.visible && <OnboardingIntro onDismiss={intro.dismiss} />}
        <SelfNameField />
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
        <CertificateTrustPanel
          prompts={trust.prompts}
          changes={trust.changes}
          onDismissChange={trust.dismissChange}
        />
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
            clock={clock}
            reconnectPolicy={reconnectPolicy}
            certificateChanges={trust.changes}
            onClose={() => {
              handleClose(entry);
            }}
            onMessagePeer={(device) => {
              handleMessagePeer(entry, device);
            }}
          />
        ))}
        {failures.map((failure) => (
          <Alert
            key={failure.key}
            color="yellow"
            title={
              <>
                No direct connection to <PeerName deviceHex={failure.peer} />
              </>
            }
            withCloseButton
            onClose={() => {
              setFailures((current) =>
                current.filter((entry) => entry.key !== failure.key),
              );
            }}
          >
            {failure.reason}. Messages go through the hub instead.
          </Alert>
        ))}
        <SearchPanel
          conversations={roomMessaging.conversations}
          onSelect={setSelectedPath}
        />
        <ConversationList
          conversations={roomMessaging.conversations}
          selected={selectedConversation?.roomPath}
          onSelect={setSelectedPath}
        />
        {selectedConversation !== undefined && (
          <RoomPanel
            key={selectedConversation.roomPath}
            view={selectedConversation}
            onSend={async (text) =>
              roomMessaging.send(selectedConversation.roomPath, text)
            }
            onPostNotice={async (text) =>
              roomMessaging.postNotice(selectedConversation.roomPath, text)
            }
            onRetry={(localId) => {
              void roomMessaging.retry(selectedConversation.roomPath, localId);
            }}
            onDiscard={(localId) => {
              roomMessaging.discard(selectedConversation.roomPath, localId);
            }}
          />
        )}
      </Stack>
    </PeerNamesProvider>
  );
}
