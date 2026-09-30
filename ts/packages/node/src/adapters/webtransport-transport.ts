import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { Http3Server } from "@fails-components/webtransport";
import {
  connectionFromByteStream,
  type ByteStream,
} from "wire-mesh-core/adapters/byte-stream-connection";
import {
  encodeCertificateHashes,
  formatPinnedAddress,
} from "wire-mesh-core/domain/pinned-address";
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
/** How long to wait before trying a failed rotation again: the port may still be held by the server just stopped. */
const ROTATION_RETRY_MS = 1000;
/** The application close code and reason sent when a certificate rotation ends a session; the code is arbitrary, and 0 is what a normal close carries. */
const SESSION_CLOSE_CODE = 0;
const ROTATION_CLOSE_REASON = "certificate rotated";

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
  readonly createUnidirectionalStream: () => Promise<
    WritableStream<Uint8Array>
  >;
  readonly ready: Promise<unknown>;
  readonly closed: Promise<unknown>;
  readonly close: (
    info: Readonly<{ closeCode: number; reason: string }>,
  ) => void;
  readonly incomingBidirectionalStreams: ReadableStream<ByteStream>;
}

function isIncomingSession(value: unknown): value is IncomingSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "ready" in value &&
    value.ready instanceof Promise &&
    "closed" in value &&
    value.closed instanceof Promise &&
    "close" in value &&
    typeof value.close === "function" &&
    "createUnidirectionalStream" in value &&
    typeof value.createUnidirectionalStream === "function" &&
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

      /** A server this listener is running, and how to retire it. */
      interface RunningServer {
        readonly server: InstanceType<typeof Http3Server>;
        /** Refuses every session that arrives from now on, ends the ones open, and resolves once they have finished closing. Stopping a server drops its sessions without telling the client, which would keep a session that no longer works until it next sends; a close lets it reconnect. A client that reconnects the moment it is told would otherwise land on this server, accepted and then dropped silently a moment later, so a session arriving while it drains is closed at once and that client's next attempt reaches the replacement. */
        readonly drain: () => Promise<void>;
      }

      /** Starts a server presenting the schedule's serving certificate. The package cannot change the certificate of a running HTTP/3 server (`updateCert` only reaches the HTTP/2 side), so a rotation replaces the server. */
      const startServer = async (): Promise<RunningServer> => {
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
        const liveSessions = new Set<IncomingSession>();
        const drainState = { draining: false };
        const endSession = (session: IncomingSession): void => {
          session.close({
            closeCode: SESSION_CLOSE_CODE,
            reason: ROTATION_CLOSE_REASON,
          });
        };
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
              if (drainState.draining) {
                endSession(session);
                return;
              }
              liveSessions.add(session);
              session.closed
                .catch(() => undefined)
                .finally(() => {
                  liveSessions.delete(session);
                });
              // Tell the client which certificates this node serves now and will serve next, on a stream of its own, so an address it was given long ago keeps working: it pins these on its next dial. The session is the pinned one, so the message needs no signature.
              const announce = await session.createUnidirectionalStream();
              const announcer = announce.getWriter();
              await announcer.write(
                encodeCertificateHashes(
                  schedule.advertised.map(
                    (certificate) => certificate.sha256Hex,
                  ),
                ),
              );
              await announcer.close();
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
        return {
          server: started,
          drain: async () => {
            drainState.draining = true;
            const open = [...liveSessions];
            for (const session of open) {
              endSession(session);
            }
            await Promise.allSettled(
              open.map(async (session) => session.closed),
            );
          },
        };
      };

      let running: RunningServer | undefined = await startServer();
      const advertise = (): readonly string[] =>
        reachableHosts(host).map((reachable) =>
          formatPinnedAddress(
            `${reachable}:${String(port)}`,
            schedule.advertised.map((certificate) => certificate.sha256Hex),
          ),
        );

      /** Drains and stops the running server, if there is one: cleared first, so a rotation that failed after this point is retried by starting a server rather than by retiring one that is already gone. */
      const retire = async (): Promise<void> => {
        const current = running;
        running = undefined;
        if (current === undefined) {
          return;
        }
        await current.drain();
        current.server.stopServer();
        await current.server.closed;
      };

      let rotation: NodeJS.Timeout | undefined;
      let closed = false;
      const untilRotation = (): number =>
        Math.max(schedule.rotatesAt.getTime() - now().getTime(), 0);
      const armRotation = (delayMs: number): void => {
        rotation = setTimeout(() => {
          void (async () => {
            schedule = await advanceCertificateSchedule(
              storage,
              now(),
              scheduleOptions,
            );
            await retire();
            if (closed) {
              return;
            }
            running = await startServer();
            options.onCertificateRenewed?.(advertise());
          })().then(
            () => {
              if (!closed) {
                armRotation(untilRotation());
              }
            },
            (error: unknown) => {
              // A rotation that fails leaves no server running, so it is retried rather than abandoned.
              reportError(error);
              if (!closed) {
                armRotation(ROTATION_RETRY_MS);
              }
            },
          );
        }, delayMs);
        rotation.unref();
      };
      armRotation(untilRotation());

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
          await retire();
        },
        unref: () => {
          rotation?.unref();
        },
      };
    },
  };
}
