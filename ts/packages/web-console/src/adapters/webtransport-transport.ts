import { connectionFromByteStream } from "wire-mesh-core/adapters/byte-stream-connection";
import { parsePinnedAddress } from "wire-mesh-core/domain/pinned-address";
import type {
  Connection,
  Listener,
  Transport,
} from "wire-mesh-core/ports/transport";

/** The path a node serves WebTransport sessions on; the same value as WEBTRANSPORT_PATH in packages/node. */
const SESSION_PATH = "/wire-mesh";

const LISTEN_UNSUPPORTED = "the web console is a client only: it cannot listen";

/**
 * A browser Transport over WebTransport to a node that serves a self-signed certificate, which the browser accepts by the pinned hash in the address (`https://host:port#sha256=<hex>`) with no certificate authority involved. One session carries one connection, on a bidirectional stream this side opens, framed as length-prefixed CBOR (core's byte-stream-connection).
 */
export function createBrowserWebTransportTransport(): Transport {
  return {
    async connect(address): Promise<Connection> {
      if (typeof WebTransport === "undefined") {
        throw new Error("this browser does not support WebTransport");
      }
      const { url, sha256 } = parsePinnedAddress(address);
      const session = new WebTransport(new URL(SESSION_PATH, url).toString(), {
        serverCertificateHashes: sha256.map((value) => ({
          algorithm: "sha-256",
          value,
        })),
      });
      await session.ready;
      const stream = await session.createBidirectionalStream();
      const connection = connectionFromByteStream(stream, { opened: true });
      // The stream alone does not always end when the server ends the session, and a console that is not told keeps a connection that no longer works until it next sends. The session's own close is the signal, so it ends the connection, which lets the mesh session reconnect.
      void session.closed
        .catch(() => undefined)
        .then(async () => connection.close());
      return connection;
    },
    async listen(): Promise<Listener> {
      return Promise.reject(new Error(LISTEN_UNSUPPORTED));
    },
  };
}
