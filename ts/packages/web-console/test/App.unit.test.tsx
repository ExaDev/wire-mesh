// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { GossipFrame } from "wire-mesh-core/generated/protocol";
import {
  decodeMessage,
  messageFromFrame,
} from "wire-mesh-core/adapters/frame-codec";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { dmRoomPath } from "wire-mesh-core/domain/room-path";
import { formatPinnedAddress } from "wire-mesh-core/domain/pinned-address";
import { signPeerAdvert } from "wire-mesh-core/domain/peer-advert";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { createNameStore } from "../src/name-store.js";
import {
  selfAssertedName,
  selfNameExtension,
  shortId,
} from "../src/peer-names.js";
import { createCertificateMemory } from "../src/certificate-memory.js";
import type { CertificateMemory } from "../src/certificate-memory.js";
import { App } from "../src/App.js";
import type { MessageStore, StoredMessage } from "../src/message-store.js";
import { bytesFromHex } from "./hex.js";
import { FakeWebSocket } from "./fake-websocket.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

/** The identity App runs as. Real rather than a stub deriving one fixed device-id: the session verifies every gossiped advert with it (wire-mesh#225), and a stub would refuse any advert naming a different device, so a gossiped peer would never reach the directory these tests read. */
let appIdentity: IdentityPort;

const fixedClock: Clock = { now: () => 0 };

function fakeMessageStore(): MessageStore {
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
let sockets: FakeWebSocket[] = [];

class TrackedFakeWebSocket extends FakeWebSocket {
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
}

function renderApp(
  options: Readonly<{
    discoverLocalNode?: () => Promise<string | undefined>;
    defaultAddress?: string;
    messageStore?: MessageStore;
    nameStorage?: KeyValueStorage;
    certificateMemory?: CertificateMemory;
  }> = {},
): ReturnType<typeof render> {
  const {
    discoverLocalNode,
    defaultAddress,
    messageStore = fakeMessageStore(),
    nameStorage = createMemoryStorage(),
    certificateMemory = createCertificateMemory(createMemoryStorage()),
  } = options;
  return render(
    <MantineProvider>
      <App
        identity={appIdentity}
        clock={fixedClock}
        messageStore={messageStore}
        roomStorage={createMemoryStorage()}
        certificateMemory={certificateMemory}
        nameStore={createNameStore(nameStorage)}
        {...(discoverLocalNode === undefined ? {} : { discoverLocalNode })}
        {...(defaultAddress === undefined ? {} : { defaultAddress })}
      />
    </MantineProvider>,
  );
}

function submitConnectForm(): void {
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

const DEVICE_ID_HEX_LENGTH = 64;
const SHA256_HEX_LENGTH = 64;
const GOSSIPED_ADDRESS = "203.0.113.5:4433";

/** The frame a remote peer gossips, carrying that peer's own signed advert, and the hex of the device it names as the UI renders it. Built once for the suite because signing is asynchronous. */
let gossipedFrame: GossipFrame;
let gossipedDeviceHex: string;

/** A second remote whose advert carries a self display name, and the hex of the device it names. */
const SELF_ASSERTED_NAME = "Ada's laptop";
let namedFrame: GossipFrame;
let namedDeviceHex: string;

/** A third remote that gossips only a certificate-pinned WebTransport address. */
const PINNED_GOSSIP_NODE = "198.51.100.7:4433";
let pinnedGossipFrame: GossipFrame;
let pinnedGossipDeviceHex: string;

beforeAll(async () => {
  appIdentity = await createWebCryptoIdentity();
  const remote = await createWebCryptoIdentity();
  const advert = await signPeerAdvert(remote, {
    device: remote.deviceId,
    addresses: [GOSSIPED_ADDRESS],
    "snapshot-seconds": 0,
    "identity-key": remote.identityKey,
  });
  gossipedFrame = { type: "gossip", peers: [advert] };
  gossipedDeviceHex = deviceIdToHex(remote.deviceId);
  const named = await createWebCryptoIdentity();
  namedFrame = {
    type: "gossip",
    peers: [
      await signPeerAdvert(named, {
        ...selfNameExtension(SELF_ASSERTED_NAME),
        device: named.deviceId,
        addresses: [GOSSIPED_ADDRESS],
        "snapshot-seconds": 0,
        "identity-key": named.identityKey,
      }),
    ],
  };
  namedDeviceHex = deviceIdToHex(named.deviceId);
  const pinnedRemote = await createWebCryptoIdentity();
  pinnedGossipFrame = {
    type: "gossip",
    peers: [
      await signPeerAdvert(pinnedRemote, {
        device: pinnedRemote.deviceId,
        addresses: [
          formatPinnedAddress(PINNED_GOSSIP_NODE, [
            "e".repeat(SHA256_HEX_LENGTH),
          ]),
        ],
        "snapshot-seconds": 0,
        "identity-key": pinnedRemote.identityKey,
      }),
    ],
  };
  pinnedGossipDeviceHex = deviceIdToHex(pinnedRemote.deviceId);
});

/** messageFromFrame's own Uint8Array may be a view into a larger backing buffer -- slicing to its own byteOffset/byteLength before handing it to emitMessage is what every other adapter test here already does (see websocket-transport.integration.test.ts's identical helper), since FakeWebSocket.emitMessage takes the raw buffer, not a view onto it. */
function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** The discovered-peer table row for a given device within an already-confirmed-present discovered-peers panel -- scoped lookup so its own "Connect" button can be found distinctly from both the connect form's identically-labelled submit button and the identical device hex rendered elsewhere (a device's own hex also renders inside its originating ConnectionPanel's unrelated "Peer directory" table). Callers must await screen.findByTestId("discovered-peers") first: the panel itself never mounts at all while no peer is pending, so this cannot also do that initial wait. */
function discoveredRow(deviceHex: string): HTMLElement {
  const row = within(screen.getByTestId("discovered-peers"))
    .getByText(shortId(deviceHex))
    .closest("tr");
  if (row === null) {
    throw new Error(`expected a table row for device ${deviceHex}`);
  }
  return row;
}

/** Connects the form's address and opens its socket, resolving once the session reports connected, which is when its frame listener is registered. */
async function connectRoot(): Promise<FakeWebSocket> {
  submitConnectForm();
  await vi.waitFor(() => {
    expect(sockets).toHaveLength(1);
  });
  const rootSocket = sockets[0];
  if (rootSocket === undefined) {
    throw new Error("expected the root socket to exist");
  }
  rootSocket.emitOpen();
  await screen.findByText(/^connected/);
  return rootSocket;
}

/** The display names carried by the gossip frames a socket sent after `from` sends. */
function publishedSelfNames(
  socket: Readonly<FakeWebSocket>,
  from: number,
): unknown[] {
  return socket.sent.slice(from).flatMap((data) => {
    const frame = decodeMessage(data);
    if (frame.type !== "gossip") return [];
    return frame.peers.flatMap((advert) => {
      const name = selfAssertedName(advert);
      return name === undefined ? [] : [name];
    });
  });
}

/** The display-name claim of each advert in every gossip frame a socket sent after `from` sends, with undefined for an advert that asserts none. */
function gossipedClaims(
  socket: Readonly<FakeWebSocket>,
  from: number,
): (string | undefined)[] {
  return socket.sent.slice(from).flatMap((data) => {
    const frame = decodeMessage(data);
    return frame.type === "gossip"
      ? frame.peers.map((advert) => selfAssertedName(advert))
      : [];
  });
}

describe("App", () => {
  beforeEach(() => {
    sockets = [];
    vi.stubGlobal("WebSocket", TrackedFakeWebSocket);
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a connecting status line for the panel once the connect form is submitted", async () => {
    renderApp();

    submitConnectForm();

    await screen.findByText("connecting…");
  });

  it("renders connected once the socket opens, and enables the ping button", async () => {
    renderApp();

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    sockets[0]?.emitOpen();

    const status = await screen.findByText(/^connected/);
    expect(status).toBeInTheDocument();
    const pingButton = await screen.findByRole("button", {
      name: "Send ping",
    });
    expect(pingButton).toBeEnabled();
  });

  it("removes the panel when its close button is clicked", async () => {
    renderApp();

    submitConnectForm();
    await screen.findByText("connecting…");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(screen.queryByText(/connecting|connected|closed/)).toBeNull();
  });

  it("does not start a second connection attempt for an address that already has one live", async () => {
    renderApp();

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    submitConnectForm();

    expect(sockets).toHaveLength(1);
  });

  it("auto-connects to a same-device node discovered on mount, with no form submission", async () => {
    renderApp({
      discoverLocalNode: async () => Promise.resolve("ws://127.0.0.1:8787"),
    });

    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    expect(String(sockets[0]?.url)).toBe("ws://127.0.0.1:8787/");
    await screen.findByText("connecting…");
  });

  it("does not start any connection when no same-device node is discovered", async () => {
    renderApp({ discoverLocalNode: async () => Promise.resolve(undefined) });

    await vi.waitFor(() => {
      expect(screen.queryByRole("button", { name: "Send ping" })).toBeNull();
    });
    expect(sockets).toHaveLength(0);
  });

  it("does not start a duplicate connection when the form is submitted for the address auto-discovery already connected", async () => {
    renderApp({
      discoverLocalNode: async () => Promise.resolve("ws://localhost:8787"),
    });

    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    submitConnectForm();

    expect(sockets).toHaveLength(1);
  });

  it("seeds the Node field from the defaultAddress prop, so a build served from a hub's own origin points at it without the operator typing anything", () => {
    renderApp({ defaultAddress: "wss://mesh.exadev.io" });

    expect(screen.getByLabelText(/^Node/)).toHaveValue("wss://mesh.exadev.io");
  });

  it("lists a conversation restored from storage as offline and shows its history, with no connection open", async () => {
    const peerHex = "2".repeat(DEVICE_ID_HEX_LENGTH);
    const store = fakeMessageStore();
    await store.append(
      dmRoomPath(deviceIdToHex(appIdentity.deviceId), peerHex),
      {
        direction: "received",
        text: "hello from before the reload",
        messageId: new Uint8Array([1]),
        sentAt: 1000,
      },
    );

    renderApp({ messageStore: store });

    const list = await screen.findByTestId("conversation-list");
    expect(within(list).getByText("222222222222")).toBeInTheDocument();
    expect(within(list).getByText("offline")).toBeInTheDocument();
    expect(
      screen.getByText("hello from before the reload"),
    ).toBeInTheDocument();
  });

  it("surfaces a gossiped peer's address as a discovered peer, and dials it once the user clicks Connect", async () => {
    renderApp();

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const rootSocket = sockets[0];
    if (rootSocket === undefined) {
      throw new Error("expected the root socket to exist");
    }
    rootSocket.emitOpen();
    // wrapWebSocket only registers its own "message" listener once createBrowserTransport's own open-event promise resolves, a microtask after emitOpen() -- waiting for the connected status line proves that listener is registered before pushing the gossip frame below, rather than racing it.
    await screen.findByText(/^connected/);
    rootSocket.emitMessage(arrayBuffer(messageFromFrame(gossipedFrame)));

    const panel = await screen.findByTestId("discovered-peers");
    expect(
      within(panel).getByText(shortId(gossipedDeviceHex)),
    ).toBeInTheDocument();
    expect(within(panel).getByText(GOSSIPED_ADDRESS)).toBeInTheDocument();

    fireEvent.click(
      within(discoveredRow(gossipedDeviceHex)).getByRole("button", {
        name: "Connect",
      }),
    );
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    // createBrowserTransport passes a parsed URL object (not a bare string) to `new WebSocket(...)`, so FakeWebSocket's own url field round-trips through URL's own normalization (a trailing "/" with no path) -- String(...) is what a real WebSocket's own .url getter would also report.
    expect(String(sockets[1]?.url)).toBe(`ws://${GOSSIPED_ADDRESS}/`);
    expect(screen.queryByTestId("discovered-peers")).toBeNull();
  });

  it("opens the conversation over the hub when the direct connection fails, and says why until dismissed", async () => {
    renderApp();

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const rootSocket = sockets[0];
    if (rootSocket === undefined) {
      throw new Error("expected the root socket to exist");
    }
    rootSocket.emitOpen();
    await screen.findByText(/^connected/);
    rootSocket.emitMessage(arrayBuffer(messageFromFrame(gossipedFrame)));

    // jsdom has no RTCPeerConnection, so the negotiation fails as soon as it starts.
    const directoryRow = (
      await screen.findAllByText(shortId(gossipedDeviceHex))
    )
      .map((cell) => cell.closest("tr"))
      .find(
        (row) =>
          row !== null &&
          within(row).queryByRole("button", { name: "Message" }) !== null,
      );
    if (directoryRow === null || directoryRow === undefined) {
      throw new Error("expected a directory row with a Message button");
    }
    fireEvent.click(
      within(directoryRow).getByRole("button", { name: "Message" }),
    );

    // The conversation is open over the hub at once, and only the direct connection failed.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      `No direct connection to ${shortId(gossipedDeviceHex)}`,
    );
    expect(alert).toHaveTextContent(/RTCPeerConnection/);
    expect(alert).toHaveTextContent("Messages go through the hub instead");
    expect(screen.getByText("via hub")).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dismissing a discovered peer removes it without dialling", async () => {
    renderApp();

    submitConnectForm();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const rootSocket = sockets[0];
    if (rootSocket === undefined) {
      throw new Error("expected the root socket to exist");
    }
    rootSocket.emitOpen();
    await screen.findByText(/^connected/);
    rootSocket.emitMessage(arrayBuffer(messageFromFrame(gossipedFrame)));

    await screen.findByTestId("discovered-peers");

    fireEvent.click(
      within(discoveredRow(gossipedDeviceHex)).getByRole("button", {
        name: "Dismiss",
      }),
    );

    expect(screen.queryByTestId("discovered-peers")).toBeNull();
    expect(sockets).toHaveLength(1);
  });

  it("names a gossiped peer by the display name its signed advert asserts, with its short id beside it", async () => {
    renderApp();

    const rootSocket = await connectRoot();
    rootSocket.emitMessage(arrayBuffer(messageFromFrame(namedFrame)));

    const panel = await screen.findByTestId("discovered-peers");
    expect(within(panel).getByText(SELF_ASSERTED_NAME)).toBeInTheDocument();
    expect(
      within(panel).getByText(shortId(namedDeviceHex)),
    ).toBeInTheDocument();
  });

  it("shows a petname from the console's own storage ahead of the name the peer asserts", async () => {
    const nameStorage = createMemoryStorage();
    await createNameStore(nameStorage).setPetname(namedDeviceHex, "Ada");
    renderApp({ nameStorage });

    const rootSocket = await connectRoot();
    rootSocket.emitMessage(arrayBuffer(messageFromFrame(namedFrame)));

    const panel = await screen.findByTestId("discovered-peers");
    expect(within(panel).getByText("Ada")).toBeInTheDocument();
    expect(within(panel).getByText(SELF_ASSERTED_NAME)).toBeInTheDocument();
  });

  it("publishes this console's own display name in a signed gossip advert once it is saved on a connected session", async () => {
    renderApp();
    const rootSocket = await connectRoot();
    const sentBefore = rootSocket.sent.length;

    fireEvent.change(screen.getByLabelText(/^Your display name/), {
      target: { value: "Grace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await vi.waitFor(() => {
      expect(publishedSelfNames(rootSocket, sentBefore)).toEqual(["Grace"]);
    });
  });

  it("retracts a published display name with an advert that carries none once the name is cleared", async () => {
    renderApp();
    const rootSocket = await connectRoot();
    fireEvent.change(screen.getByLabelText(/^Your display name/), {
      target: { value: "Grace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await vi.waitFor(() => {
      expect(publishedSelfNames(rootSocket, 0)).toEqual(["Grace"]);
    });
    const sentBefore = rootSocket.sent.length;

    fireEvent.change(screen.getByLabelText(/^Your display name/), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await vi.waitFor(() => {
      expect(gossipedClaims(rootSocket, sentBefore)).toEqual([undefined]);
    });
  });

  describe("certificate trust", () => {
    const NODE = "192.0.2.5:4433";
    const pinned = (digit: string): string =>
      formatPinnedAddress(NODE, [digit.repeat(SHA256_HEX_LENGTH)]);
    const hashBytes = (digit: string): Uint8Array<ArrayBuffer> =>
      bytesFromHex(digit.repeat(SHA256_HEX_LENGTH));

    function submitAddress(address: string): void {
      fireEvent.change(screen.getByLabelText(/^Node/), {
        target: { value: address },
      });
      submitConnectForm();
    }

    it("asks before first connecting to a pinned node and dials nothing until the user trusts it", async () => {
      const certificateMemory = createCertificateMemory(createMemoryStorage());
      renderApp({ certificateMemory });

      submitAddress(pinned("a"));

      const prompt = await screen.findByTestId("certificate-prompt");
      expect(
        within(prompt).getByText(`First connection to ${NODE}`),
      ).toBeInTheDocument();
      expect(screen.queryByText(/connecting|closed/)).toBeNull();
      expect(await certificateMemory.recall(NODE)).toEqual([]);

      fireEvent.click(
        within(prompt).getByRole("button", { name: "Trust and connect" }),
      );

      await screen.findByText(/^closed|connecting/);
      expect(await certificateMemory.recall(NODE)).toEqual([hashBytes("a")]);
      expect(screen.queryByTestId("certificate-prompt")).toBeNull();
    });

    it("connects to nothing and remembers nothing when the first-use prompt is cancelled", async () => {
      const certificateMemory = createCertificateMemory(createMemoryStorage());
      renderApp({ certificateMemory });

      submitAddress(pinned("a"));
      const prompt = await screen.findByTestId("certificate-prompt");
      fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));

      await vi.waitFor(() => {
        expect(screen.queryByTestId("certificate-prompt")).toBeNull();
      });
      expect(screen.queryByText(/connecting|closed/)).toBeNull();
      expect(await certificateMemory.recall(NODE)).toEqual([]);
    });

    it("connects without asking when the address presents a remembered certificate", async () => {
      const certificateMemory = createCertificateMemory(createMemoryStorage());
      await certificateMemory.remember(NODE, [hashBytes("a")]);
      renderApp({ certificateMemory });

      submitAddress(pinned("a"));

      await screen.findByText(/^closed|connecting/);
      expect(screen.queryByTestId("certificate-prompt")).toBeNull();
    });

    it("warns, and dials nothing, when an address presents a different certificate than the remembered one", async () => {
      const certificateMemory = createCertificateMemory(createMemoryStorage());
      await certificateMemory.remember(NODE, [hashBytes("a")]);
      renderApp({ certificateMemory });

      submitAddress(pinned("b"));

      const prompt = await screen.findByTestId("certificate-prompt");
      expect(
        within(prompt).getByText(`Certificate changed for ${NODE}`),
      ).toBeInTheDocument();
      expect(screen.queryByText(/connecting|closed/)).toBeNull();
      expect(await certificateMemory.recall(NODE)).toEqual([hashBytes("a")]);

      fireEvent.click(
        within(prompt).getByRole("button", {
          name: "Trust the new certificate",
        }),
      );

      await screen.findByText(/^closed|connecting/);
      expect(await certificateMemory.recall(NODE)).toEqual([hashBytes("b")]);
    });
  });

  it("asks about a gossiped node's certificate after the user connects to it, before dialling", async () => {
    renderApp();

    const rootSocket = await connectRoot();
    rootSocket.emitMessage(arrayBuffer(messageFromFrame(pinnedGossipFrame)));
    await screen.findByTestId("discovered-peers");
    fireEvent.click(
      within(discoveredRow(pinnedGossipDeviceHex)).getByRole("button", {
        name: "Connect",
      }),
    );

    const prompt = await screen.findByTestId("certificate-prompt");
    expect(
      within(prompt).getByText(`First connection to ${PINNED_GOSSIP_NODE}`),
    ).toBeInTheDocument();
  });

  it("tells what happened on a connection in words, with the raw frames behind a toggle", async () => {
    renderApp({ defaultAddress: "ws://hub.example:8787" });

    const rootSocket = await connectRoot();
    rootSocket.emitMessage(arrayBuffer(messageFromFrame(namedFrame)));

    const log = await screen.findByTestId("activity-log");
    expect(
      within(log).getByText(/^Connected to ws:\/\/hub\.example:8787/),
    ).toBeInTheDocument();
    await within(log).findByText(/^Peer seen:/);
    expect(screen.queryByTestId("frame-log")).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Show raw frames" }));

    const raw = screen.getByTestId("frame-log");
    expect(within(raw).getAllByText("received").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("activity-log")).toBeNull();
  });

  it("shows when the next reconnect attempt is due after a connection drops", async () => {
    renderApp();

    const rootSocket = await connectRoot();
    rootSocket.close();

    const status = await screen.findByTestId("reconnect-status");
    expect(status).toHaveTextContent(
      /Retrying (in \d+ s|now) \(attempt 1 of 5\)/,
    );
  });

  it("shows when a peer in the directory was last seen", async () => {
    renderApp();

    const rootSocket = await connectRoot();
    rootSocket.emitMessage(arrayBuffer(messageFromFrame(gossipedFrame)));

    await screen.findByTestId("discovered-peers");
    // The advert's snapshot and the fixed test clock are both zero.
    expect(screen.getAllByText("just now").length).toBeGreaterThan(0);
  });

  it("names the connection a discovered peer was gossiped over", async () => {
    renderApp({ defaultAddress: "ws://hub.example:8787" });

    const rootSocket = await connectRoot();
    rootSocket.emitMessage(arrayBuffer(messageFromFrame(gossipedFrame)));

    const panel = await screen.findByTestId("discovered-peers");
    expect(
      within(panel).getByText("over ws://hub.example:8787"),
    ).toBeInTheDocument();
  });
});
