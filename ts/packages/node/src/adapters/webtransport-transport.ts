import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { Http3Server } from "@fails-components/webtransport";
import {
  connectionFromByteStream,
  type ByteStream,
} from "wire-mesh-core/adapters/byte-stream-connection";
import { formatPinnedAddress } from "wire-mesh-core/domain/pinned-address";
import type {
  Connection,
  Listener,
  Transport,
} from "wire-mesh-core/ports/transport";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import {
  advanceCertificateSchedule,
  type CertificateSchedule,
} from "./certificate-schedule.js";

/** The path a client opens its WebTransport session on. */
export const WEBTRANSPORT_PATH = "/wire-mesh";

const SECRET_BYTES = 32;

const WILDCARD_HOSTS: readonly string[] = ["0.0.0.0", "::"];

/** The hosts a client can dial for a listener bound to `host`: the host itself, or for a wildcard every non-internal IPv4 address of this machine. */
function reachableHosts(host: string): readonly string[] {
  if (!WILDCARD_HOSTS.includes(host)) {
    return [host];
  }
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

/** The optional WebTransport package is not installed, or its native binary was not built for this platform. */
export class WebTransportUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "serving WebTransport needs the optional dependency @fails-components/webtransport and its native binary, which is missing: either no binary is published for this platform, or the package manager skipped its install script (an ignore-scripts setting does that)",
      { cause },
    );
    this.name = "WebTransportUnavailableError";
  }
}

/** A listener that also says the addresses a client pins, which change as the certificate schedule advances. */
export interface WebTransportListener extends Listener {
  /** One `https://host:port#sha256=<hex>[,<hex>...]` per address a client can reach: the address and the hashes of the certificate served now and those that will replace it. A listener bound to a wildcard address has one for each non-internal IPv4 address of this machine, since a wildcard is not something a client can dial. */
  readonly advertisedAddresses: readonly string[];
}

/** Transport whose listeners report the address a client pins. */
export interface WebTransportTransport extends Transport {
  listen: (
    address: string,
    onConnection: (connection: Readonly<Connection>) => void,
  ) => Promise<WebTransportListener>;
}

export interface WebTransportTransportOptions {
  /** Where the certificate schedule is kept. A node restarted over the same storage serves the same certificates, so the addresses it already handed out stay valid; the default keeps them in memory only, and a restart then starts a new schedule. */
  storage?: KeyValueStorage;
  /** How long each certificate is valid; the WebTransport limit less a margin unless a test asks for less. */
  certificateLifetimeMs?: number;
  /** Called with a failure that belongs to one session or to a certificate renewal, neither of which should stop the listener. */
  onError?: (error: unknown) => void;
  /** Called with the new advertised addresses each time the schedule rotates to its next certificate. */
  onCertificateRenewed?: (advertisedAddresses: readonly string[]) => void;
  /** The current time, injected so a test can move it. */
  now?: () => Date;
}

async function loadHttp3Server(): Promise<typeof Http3Server> {
  try {
    // The server package catches a failure to load the native binary, logs it and resolves `quicheLoaded` anyway, so a node with no binary would start and serve nothing. Loading the binary's own package here lets that failure reach the caller.
    await import("@fails-components/webtransport-transport-http3-quiche");
    const module = await import("@fails-components/webtransport");
    await module.quicheLoaded;
    return module.Http3Server;
  } catch (error) {
    throw new WebTransportUnavailableError(error);
  }
}

/** A session as the server hands it out, narrowed to what this adapter uses; the package's own session type does not resolve under this project's compiler settings. */
interface IncomingSession {
  readonly ready: Promise<unknown>;
  readonly incomingBidirectionalStreams: ReadableStream<ByteStream>;
}

function isIncomingSession(value: unknown): value is IncomingSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "ready" in value &&
    value.ready instanceof Promise &&
    "incomingBidirectionalStreams" in value &&
    value.incomingBidirectionalStreams instanceof ReadableStream
  );
}

/**
 * A WebTransport Transport: each session carries one connection, on the first bidirectional stream the client opens, framed as length-prefixed CBOR (core's byte-stream-connection). A server binds a UDP port and serves a self-signed ECDSA certificate it renews on a schedule, which a browser accepts by pinning its hash (`serverCertificateHashes`) with no certificate authority involved.
 *
 * `listen` rejects with WebTransportUnavailableError when the optional native dependency is absent. `connect` always rejects: see its comment.
 */
export function createWebTransportTransport(
  options: Readonly<WebTransportTransportOptions> = {},
): WebTransportTransport {
  const now = options.now ?? (() => new Date());
  const reportError = (error: unknown): void => {
    options.onError?.(error);
  };
  return {
    // The package's Node client verifies a server certificate against the system's trust and has no way to pin a hash, so it cannot reach a server that serves a self-signed certificate. A browser is the client of this transport; node peers reach each other over WebSocket.
    async connect(): Promise<Connection> {
      return Promise.reject(
        new Error(
          "a Node process cannot dial WebTransport with a pinned certificate hash; dial a wss:// address instead",
        ),
      );
    },
    async listen(address, onConnection): Promise<WebTransportListener> {
      const Http3ServerClass = await loadHttp3Server();
      const storage = options.storage ?? createMemoryStorage();
      const scheduleOptions =
        options.certificateLifetimeMs === undefined
          ? {}
          : { lifetimeMs: options.certificateLifetimeMs };
      const lastColon = address.lastIndexOf(":");
      const host = address.slice(0, lastColon);
      let port = Number(address.slice(lastColon + 1));
      let schedule: CertificateSchedule = await advanceCertificateSchedule(
        storage,
        now(),
        scheduleOptions,
      );

      /** Starts a server presenting the schedule's serving certificate. The package cannot change the certificate of a running HTTP/3 server (`updateCert` only reaches the HTTP/2 side), so a rotation replaces the server. */
      const startServer = async (): Promise<
        InstanceType<typeof Http3Server>
      > => {
        const started = new Http3ServerClass({
          host,
          port,
          secret: randomBytes(SECRET_BYTES).toString("hex"),
          cert: schedule.serving.certificatePem,
          privKey: schedule.serving.privateKeyPem,
        });
        started.startServer();
        await started.ready;
        const bound = started.address();
        if (bound === null) {
          throw new Error("the WebTransport server bound no address");
        }
        port = bound.port;
        void (async () => {
          for await (const session of started.sessionStream(
            WEBTRANSPORT_PATH,
          )) {
            void (async () => {
              if (!isIncomingSession(session)) {
                throw new Error(
                  "the WebTransport server yielded a malformed session",
                );
              }
              await session.ready;
              // Take the first stream and release the reader without cancelling: leaving a for-await loop early cancels the stream, and the package then closes the cancelled stream again when the session ends, which throws in its own UDP handler and takes the process down.
              const reader = session.incomingBidirectionalStreams.getReader();
              const first = await reader.read();
              reader.releaseLock();
              if (!first.done) {
                onConnection(connectionFromByteStream(first.value));
              }
            })().catch(reportError);
          }
        })().catch(reportError);
        return started;
      };

      let server = await startServer();
      const advertise = (): readonly string[] =>
        reachableHosts(host).map((reachable) =>
          formatPinnedAddress(
            `${reachable}:${String(port)}`,
            schedule.advertised.map((certificate) => certificate.sha256Hex),
          ),
        );

      let rotation: NodeJS.Timeout | undefined;
      let closed = false;
      const armRotation = (): void => {
        rotation = setTimeout(
          () => {
            void (async () => {
              schedule = await advanceCertificateSchedule(
                storage,
                now(),
                scheduleOptions,
              );
              server.stopServer();
              await server.closed;
              if (closed) {
                return;
              }
              server = await startServer();
              options.onCertificateRenewed?.(advertise());
              armRotation();
            })().catch(reportError);
          },
          Math.max(schedule.rotatesAt.getTime() - now().getTime(), 0),
        );
        rotation.unref();
      };
      armRotation();

      return {
        get address() {
          return `${host}:${String(port)}`;
        },
        get advertisedAddresses() {
          return advertise();
        },
        close: async () => {
          closed = true;
          clearTimeout(rotation);
          server.stopServer();
          await server.closed;
        },
        unref: () => {
          rotation?.unref();
        },
      };
    },
  };
}
