// Browser-side driver for scripts/live-check.mjs. Loaded via harness.html under the vite dev server, this exposes a small window.harness API the Playwright script calls with page.evaluate -- real createWebCryptoIdentity, createMeshSession, createWebrtcNegotiator, and wrapRtcDataChannel, exercised against a real RTCPeerConnection and a real WebSocket connection to a real wire-mesh-node relay (see scripts/live-check.mjs's own header for why a real relay, not a bespoke broadcast one, is what this check now boots). Not part of the production console UI or its built bundle (vite's default build entry is index.html at the project root; this page is never referenced from there).

import { cdeEncodeOptions, encode } from "cbor2";
import type {
  CapabilityToken,
  Frame,
  TokenClaims,
} from "@exadev/wire-mesh-core/generated/protocol";
import type { Connection } from "@exadev/wire-mesh-core/ports/transport";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { createBrowserTransport } from "../src/adapters/websocket-transport.js";
import { createMeshSession, type SessionEvent } from "../src/mesh-session.js";
import {
  WEBRTC_SIGNAL_SCOPE,
  WEBRTC_SIGNAL_VERB,
  createWebrtcNegotiator,
} from "../src/webrtc-negotiation.js";

const HOUR_MS = 3_600_000;

/** A gossip frame's own on-wire shape, with its one Uint8Array field carried as a plain number array -- page.evaluate's args/return values must be JSON-serialisable, so this is the harness's explicit, narrow (de)serialisation for exactly the one frame shape this live-check exchanges, not a generic Frame codec. */
interface WireGossip {
  type: "gossip";
  peers: {
    device: number[];
    addresses: string[];
    "snapshot-seconds": number;
  }[];
}

function gossipFrameFromWire(wire: Readonly<WireGossip>): Frame {
  return {
    type: "gossip",
    peers: wire.peers.map((peer) => ({
      device: Uint8Array.from(peer.device),
      addresses: peer.addresses,
      "snapshot-seconds": peer["snapshot-seconds"],
    })),
  };
}

function wireFromGossipFrame(frame: Readonly<Frame>): WireGossip {
  if (frame.type !== "gossip") {
    throw new Error(`expected a gossip frame, got ${frame.type}`);
  }
  return {
    type: "gossip",
    peers: frame.peers.map((peer) => ({
      device: Array.from(peer.device),
      addresses: peer.addresses,
      "snapshot-seconds": peer["snapshot-seconds"],
    })),
  };
}

function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

/** Mints a self-issued, self-signed capability token authorising this harness's own identity to invoke webrtc:signal against a node scope -- the same construction as core's own conformance-vector tokens, minus a parent delegation. */
async function mintSelfToken(
  identity: Awaited<ReturnType<typeof createWebCryptoIdentity>>,
  now: number,
): Promise<CapabilityToken> {
  const claims: TokenClaims = {
    "token-id": buf([1]),
    issuer: identity.deviceId,
    "issuer-key": identity.identityKey,
    bearer: identity.deviceId,
    capability: WEBRTC_SIGNAL_VERB,
    scope: WEBRTC_SIGNAL_SCOPE,
    expires: now + HOUR_MS,
  };
  const payload = buf(encode(claims, cdeEncodeOptions));
  const protectedHeader = buf(encode({}, cdeEncodeOptions));
  const toBeSigned = buf(
    encode(
      ["Signature1", protectedHeader, new Uint8Array(0), payload],
      cdeEncodeOptions,
    ),
  );
  const signature = await identity.sign(toBeSigned);
  return [protectedHeader, {}, payload, signature];
}

let negotiatorRef: ReturnType<typeof createWebrtcNegotiator> | null = null;
let latestSessionEvent: SessionEvent | null = null;
const connections = new Map<string, Connection>();
let nextConnectionId = 0;
const incomingConnectionIds: string[] = [];
const incomingWaiters: ((id: string) => void)[] = [];

/** A frame-log entry reduced to what scripts/live-check.mjs needs to verify the signaling exchange actually completed via the relay, independent of whether the resulting RTCPeerConnection's own ICE handshake ever reaches "connected" -- see the module-level comment on ICE's own sandbox limitation. */
interface FrameSummaryEntry {
  direction: "sent" | "received";
  type: string;
  verb?: string;
  result?: string;
}

function summarizeFrame(
  entry: SessionEvent["frameLog"][number],
): FrameSummaryEntry {
  const { direction, frame } = entry;
  if (frame.type === "manage-request") {
    // Most ManageCommandParams variants carry a literal verb string, but the generic namespaced-verb fallback (an open catchall object, mirroring Rust's ManageParams::Json) types it as unknown -- narrow before use rather than assume every variant agrees.
    const { params } = frame.command;
    const verb =
      "verb" in params && typeof params.verb === "string"
        ? params.verb
        : undefined;
    return {
      direction,
      type: frame.type,
      ...(verb !== undefined ? { verb } : {}),
    };
  }
  if (frame.type === "manage-response") {
    return { direction, type: frame.type, result: frame.outcome.result };
  }
  return { direction, type: frame.type };
}

function registerConnection(connection: Readonly<Connection>): string {
  const id = String(nextConnectionId);
  nextConnectionId += 1;
  connections.set(id, connection);
  return id;
}

function requireConnection(id: string): Connection {
  const connection = connections.get(id);
  if (connection === undefined) {
    throw new Error(`unknown connection id ${id}`);
  }
  return connection;
}

declare global {
  interface Window {
    harness: {
      /** Connects to the relay and returns this session's own device-id (a plain number array -- page.evaluate's return value must be JSON-serialisable), so the caller can hand it to the OTHER context's initiate() call as the peer to dial. */
      connect: (address: string) => Promise<number[]>;
      /** Offers a WebRTC data channel to targetDevice (this session's own device-id array from another context's connect()), routed via a relay-connect pairing to that specific peer since a real relay hub drops manage-request/manage-response frames sent to it directly. */
      initiate: (targetDevice: readonly number[]) => Promise<string>;
      /** This session's frame log, reduced to a JSON-serialisable summary -- lets the driving script confirm the offer/answer/ice-candidate manage-requests actually round-tripped through the relay's real relay-data forwarding, independent of whether the underlying RTCPeerConnection's own ICE handshake ever reaches "connected". */
      frameSummary: () => FrameSummaryEntry[];
      waitForIncoming: () => Promise<string>;
      sendGossip: (connectionId: string, wire: WireGossip) => Promise<void>;
      receiveGossip: (connectionId: string) => Promise<WireGossip>;
      closeConnection: (connectionId: string) => Promise<void>;
    };
  }
}

window.harness = {
  async connect(address: string): Promise<number[]> {
    const clock = { now: () => Date.now() };
    const identity = await createWebCryptoIdentity();
    const session = createMeshSession(
      createBrowserTransport(),
      identity,
      clock,
    );
    const negotiator = createWebrtcNegotiator(session, {
      identity,
      clock,
      onIncomingConnection: (connection) => {
        const id = registerConnection(connection);
        const waiter = incomingWaiters.shift();
        if (waiter) {
          waiter(id);
        } else {
          incomingConnectionIds.push(id);
        }
      },
    });
    const token = await mintSelfToken(identity, clock.now());
    session.setToken(token);
    negotiatorRef = negotiator;
    void (async (): Promise<void> => {
      for await (const event of session.events) {
        latestSessionEvent = event;
      }
    })();
    await session.connect(address, []);
    return Array.from(identity.deviceId);
  },
  async initiate(targetDevice: readonly number[]): Promise<string> {
    if (negotiatorRef === null) {
      throw new Error("not connected");
    }
    const connection = await negotiatorRef.initiate(
      Uint8Array.from(targetDevice),
    );
    return registerConnection(connection);
  },
  frameSummary(): FrameSummaryEntry[] {
    return latestSessionEvent === null
      ? []
      : latestSessionEvent.frameLog.map(summarizeFrame);
  },
  async waitForIncoming(): Promise<string> {
    const existing = incomingConnectionIds.shift();
    if (existing !== undefined) {
      return existing;
    }
    return new Promise((resolve) => {
      incomingWaiters.push(resolve);
    });
  },
  async sendGossip(connectionId: string, wire: WireGossip): Promise<void> {
    await requireConnection(connectionId).send(gossipFrameFromWire(wire));
  },
  async receiveGossip(connectionId: string): Promise<WireGossip> {
    const iterator = requireConnection(connectionId)
      .receive()
      [Symbol.asyncIterator]();
    const result = await iterator.next();
    if (result.done === true) {
      throw new Error("connection ended before a frame arrived");
    }
    return wireFromGossipFrame(result.value);
  },
  async closeConnection(connectionId: string): Promise<void> {
    await requireConnection(connectionId).close();
  },
};
