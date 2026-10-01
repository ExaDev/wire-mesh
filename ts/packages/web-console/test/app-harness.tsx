// What a test of the whole App needs: the identity and stores it runs with, a WebSocket that records every connection the tree makes, and the helpers that render the App and reach a connected session. Shared by the App test files so each stays within the line cap and none re-implements the harness.

import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import type { Clock } from "wire-mesh-core/ports/clock";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { createIdentityBackupService } from "../src/adapters/identity-backup.js";
import { createCertificateMemory } from "../src/certificate-memory.js";
import type { CertificateMemory } from "../src/certificate-memory.js";
import { createNameStore } from "../src/name-store.js";
import { createPreferencesStore } from "../src/preferences-store.js";
import type { MessageStore, StoredMessage } from "../src/message-store.js";
import { App } from "../src/App.js";
import { testCapabilities } from "./capability-services.js";
import type { TestCapabilities } from "./capability-services.js";
import { FakeWebSocket } from "./fake-websocket.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

/** The identity App runs as. Real rather than a stub deriving one fixed device-id: the session verifies every gossiped advert with it (wire-mesh#225), and a stub would refuse any advert naming a different device, so a gossiped peer would never reach the directory these tests read. */
let identity: IdentityPort | undefined;

/** The grant and revocation stores a test renders App with unless it supplies its own, recreated for every test so one test's grants never show in the next. */
let capabilities: TestCapabilities | undefined;

export const fixedClock: Clock = { now: () => 0 };

export function fakeMessageStore(): MessageStore {
  const stored = new Map<string, StoredMessage[]>();
  return {
    async append(roomPath, message): Promise<void> {
      const existing = stored.get(roomPath) ?? [];
      stored.set(roomPath, [...existing, message]);
      return Promise.resolve();
    },
    async list(roomPath): Promise<StoredMessage[]> {
      return Promise.resolve(stored.get(roomPath) ?? []);
    },
    async roomPaths(): Promise<string[]> {
      return Promise.resolve([...stored.keys()]);
    },
  };
}

/** Every FakeWebSocket App's own createBrowserTransport() constructs, in construction order -- tracking a `new WebSocket(url)` call site that lives entirely inside the component tree under test, not something the test itself can pass a fake into directly. */
let opened: FakeWebSocket[] = [];

class TrackedFakeWebSocket extends FakeWebSocket {
  constructor(url: string) {
    super(url);
    opened.push(this);
  }
}

/** Storage holding the answer of a device whose user has already dismissed the intro. */
export function dismissedPreferencesStorage(): KeyValueStorage {
  const storage = createMemoryStorage();
  void createPreferencesStore(storage).setIntroDismissed(true);
  return storage;
}

export function renderApp(
  options: Readonly<{
    discoverLocalNode?: () => Promise<string | undefined>;
    defaultAddress?: string;
    messageStore?: MessageStore;
    nameStorage?: KeyValueStorage;
    certificateMemory?: CertificateMemory;
    /** The storage the intro preference is kept in. Defaults to one where the intro was already dismissed, so tests not about it see the console as a returning user does. */
    preferencesStorage?: KeyValueStorage;
    /** Defaults to fresh grant and revocation stores for this test. */
    capabilities?: TestCapabilities;
    identityBackupStorage?: KeyValueStorage;
  }> = {},
): ReturnType<typeof render> {
  const {
    discoverLocalNode,
    defaultAddress,
    messageStore = fakeMessageStore(),
    nameStorage = createMemoryStorage(),
    certificateMemory = createCertificateMemory(createMemoryStorage()),
    preferencesStorage = dismissedPreferencesStorage(),
    capabilities: suppliedCapabilities = currentCapabilities(),
    identityBackupStorage = createMemoryStorage(),
  } = options;
  return render(
    <MantineProvider>
      <App
        identity={appIdentity()}
        clock={fixedClock}
        messageStore={messageStore}
        certificateMemory={certificateMemory}
        nameStore={createNameStore(nameStorage)}
        preferences={createPreferencesStore(preferencesStorage)}
        grants={suppliedCapabilities.grants}
        revocations={suppliedCapabilities.revocations}
        identityBackup={createIdentityBackupService(identityBackupStorage)}
        {...(discoverLocalNode === undefined ? {} : { discoverLocalNode })}
        {...(defaultAddress === undefined ? {} : { defaultAddress })}
      />
    </MantineProvider>,
  );
}

export function submitConnectForm(): void {
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

/** messageFromFrame's own Uint8Array may be a view into a larger backing buffer -- slicing to its own byteOffset/byteLength before handing it to emitMessage is what every other adapter test here already does (see websocket-transport.integration.test.ts's identical helper), since FakeWebSocket.emitMessage takes the raw buffer, not a view onto it. */
export function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/** Connects the form's address and opens its socket, resolving once the session reports connected, which is when its frame listener is registered. */
export async function connectRoot(): Promise<FakeWebSocket> {
  submitConnectForm();
  await vi.waitFor(() => {
    expect(sockets()).toHaveLength(1);
  });
  const rootSocket = sockets()[0];
  if (rootSocket === undefined) {
    throw new Error("expected the root socket to exist");
  }
  rootSocket.emitOpen();
  await screen.findByText(/^connected/);
  return rootSocket;
}

/** The identity App runs as, created once per file. */
export function appIdentity(): IdentityPort {
  if (identity === undefined) {
    throw new Error("installAppHarness must be called before the tests run");
  }
  return identity;
}

/** The grant and revocation stores of the running test. */
export function currentCapabilities(): TestCapabilities {
  if (capabilities === undefined) {
    throw new Error("installAppHarness must be called before the tests run");
  }
  return capabilities;
}

/** Every socket the App has opened in the running test, in construction order. */
export function sockets(): readonly FakeWebSocket[] {
  return opened;
}

/** Registers the hooks that give each test a fresh set of stores, no sockets and the fake WebSocket. Called once at the top level of a test file, before its describe blocks. */
export function installAppHarness(): void {
  beforeAll(async () => {
    identity = await createWebCryptoIdentity();
  });
  beforeEach(async () => {
    capabilities = await testCapabilities(appIdentity(), fixedClock);
    opened = [];
    vi.stubGlobal("WebSocket", TrackedFakeWebSocket);
    stubMantineJsdomGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}
