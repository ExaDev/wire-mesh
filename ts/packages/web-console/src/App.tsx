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
import type { ReconnectPolicy } from "wire-mesh-core/domain/mesh-session";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { DeviceId } from "wire-mesh-core/generated/protocol";
import { createBrowserTransport } from "./adapters/websocket-transport.js";
import { createWebrtcNegotiator } from "./webrtc-negotiation.js";
import type { WebrtcNegotiator } from "./webrtc-negotiation.js";
import { ConnectionPanel } from "./components/ConnectionPanel.js";
import { RoomPanel } from "./components/RoomPanel.js";
import { useRoomMessaging } from "./hooks/use-room-messaging.js";
import type { MessageStore } from "./message-store.js";
import { appShell } from "./App.css.js";

export interface AppProps {
  identity: IdentityPort;
  clock: Clock;
  messageStore: MessageStore;
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

export function App({
  identity,
  clock,
  messageStore,
}: Readonly<AppProps>): React.JSX.Element {
  const [address, setAddress] = useState(DEFAULT_ADDRESS);
  const [domains, setDomains] = useState<string[]>(DEFAULT_DOMAINS);
  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const roomMessaging = useRoomMessaging(identity, clock, messageStore);

  // A negotiator's own onIncomingConnection callback is registered once, at construction, and must still call whatever the *latest* attach is -- attach itself is a fresh function every time useRoomMessaging's own session map changes, so a ref (updated every render, read from the callback) is what keeps that call from closing over a stale, since-superseded attach.
  const attachRef = useRef(roomMessaging.attach);
  useEffect(() => {
    attachRef.current = roomMessaging.attach;
  }, [roomMessaging.attach]);

  function handleSubmit(event: React.SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    // Re-submitting an address that already has a live entry is a no-op: an entry is removed either by its own panel's close button, or automatically when its connect attempt fails, so resubmitting the same address after a failure starts a fresh attempt, but resubmitting while still connecting/connected/reconnecting is a no-op rather than a silent duplicate.
    if (connections.some((entry) => entry.address === address)) {
      return;
    }
    const session = createMeshSession(
      createBrowserTransport(),
      identity,
      clock,
      reconnectPolicy,
    );
    const negotiator = createWebrtcNegotiator(session, {
      identity,
      clock,
      onIncomingConnection: (connection: Readonly<Connection>) => {
        void attachRef.current(connection);
      },
    });
    setConnections((current) => [...current, { address, session, negotiator }]);
    void session.connect(address, domains).catch(() => {
      // ConnectionPanel's own render of the session's events already surfaces a connect failure via its status line; nothing further to do here beyond letting the entry remain (its own close button still works on a failed session).
    });
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
        />
      ))}
    </Stack>
  );
}
