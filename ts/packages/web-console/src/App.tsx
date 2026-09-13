// Top-level layout: the connect form and the list of currently open connection panels. Owns only the set of live sessions -- everything about rendering one session's own state lives in ConnectionPanel.

import { useState } from "react";
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
import { createBrowserTransport } from "./adapters/websocket-transport.js";
import { ConnectionPanel } from "./components/ConnectionPanel.js";

export interface AppProps {
  identity: IdentityPort;
  clock: Clock;
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
}

export function App({
  identity,
  clock,
}: Readonly<AppProps>): React.JSX.Element {
  const [address, setAddress] = useState(DEFAULT_ADDRESS);
  const [domains, setDomains] = useState<string[]>(DEFAULT_DOMAINS);
  const [connections, setConnections] = useState<ConnectionEntry[]>([]);

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
    setConnections((current) => [...current, { address, session }]);
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

  return (
    <Stack p="md" gap="lg">
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
        />
      ))}
    </Stack>
  );
}
