import { connectionFromByteStream } from "wire-mesh-core/adapters/byte-stream-connection";
import {
  decodeCertificateHashes,
  mergeHashes,
  parsePinnedAddress,
  withPinnedHashes,
} from "wire-mesh-core/domain/pinned-address";
import type {
  Connection,
  Listener,
  Transport,
} from "wire-mesh-core/ports/transport";
import type { CertificateMemory } from "../certificate-memory.js";

/** The path a node serves WebTransport sessions on; the same value as WEBTRANSPORT_PATH in packages/node. */
const SESSION_PATH = "/wire-mesh";

/**
 * How long to wait for a stream to open before deciding this browser cannot open one to this node. The specification has a stream wait for the peer's credit, which a healthy node grants within a round trip. Safari waits for session-level flow-control capsules that the node's HTTP/3 library never sends, so its `createBidirectionalStream()` never settles and the console would sit on "connecting" with nothing to say why.
 * https://github.com/fails-components/webtransport/issues/490
 */
export const STREAM_OPEN_TIMEOUT_MS = 8000;

const LISTEN_UNSUPPORTED = "the web console is a client only: it cannot listen";

/** Everything the node sent on the stream it opened for the purpose, joined. */
async function readAnnouncement(
  session: Readonly<WebTransport>,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const streams = session.incomingUnidirectionalStreams.getReader();
  const first = await streams.read();
  streams.releaseLock();
  if (first.done) {
    throw new Error("the node opened no announcement stream");
  }
  // The DOM typings leave a stream's chunks as `any`, so what arrives is checked rather than assumed.
  const opened: unknown = first.value;
  if (!(opened instanceof ReadableStream)) {
    throw new Error("the announcement stream is not a readable stream");
  }
  const chunks: Uint8Array[] = [];
  const reader: ReadableStreamDefaultReader<unknown> = opened.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    if (!(chunk.value instanceof Uint8Array)) {
      throw new Error("the announcement carried something other than bytes");
    }
    chunks.push(chunk.value);
  }
  const joined = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return decodeCertificateHashes(joined);
}

/** Opens the connection's bidirectional stream, or closes the session and says why it could not. */
async function openStream(
  session: Readonly<WebTransport>,
): Promise<WebTransportBidirectionalStream> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed out">((resolve) => {
    timer = setTimeout(() => {
      resolve("timed out");
    }, STREAM_OPEN_TIMEOUT_MS);
  });
  try {
    const opened = await Promise.race([
      session.createBidirectionalStream(),
      timedOut,
    ]);
    if (opened === "timed out") {
      session.close();
      throw new Error(
        "this browser cannot open a stream to this node: it is waiting for flow-control credit the node never grants, which is how Safari behaves with the node's HTTP/3 library (fails-components/webtransport#490); reach the node over wss:// instead",
      );
    }
    return opened;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A browser Transport over WebTransport to a node that serves a self-signed certificate, which the browser accepts by the pinned hashes in the address (`https://host:port#sha256=<hex>[,<hex>...]`) with no certificate authority involved. One session carries one connection, on a bidirectional stream this side opens, framed as length-prefixed CBOR (core's byte-stream-connection).
 *
 * The node announces the certificates it serves now and next on a stream of its own. They are remembered per node, pinned together with the address's own hashes on the next dial, and offered to the mesh session as the address to redial, so an address given long ago keeps working for as long as the console keeps reconnecting.
 */
export function createBrowserWebTransportTransport(
  memory: Readonly<CertificateMemory>,
): Transport {
  return {
    async connect(address): Promise<Connection> {
      if (typeof WebTransport === "undefined") {
        throw new Error("this browser does not support WebTransport");
      }
      const { url, sha256 } = parsePinnedAddress(address);
      const node = new URL(url).host;
      // What the address says and what was last announced: the browser accepts a certificate matching any of them, so neither being stale matters.
      const pinned = mergeHashes(sha256, await memory.recall(node));
      const session = new WebTransport(new URL(SESSION_PATH, url).toString(), {
        serverCertificateHashes: pinned.map((value) => ({
          algorithm: "sha-256",
          value,
        })),
      });
      await session.ready;
      const stream = await openStream(session);
      const connection = connectionFromByteStream(stream, { opened: true });
      // The stream alone does not always end when the server ends the session, and a console that is not told keeps a connection that no longer works until it next sends. The session's own close is the signal, so it ends the connection, which lets the mesh session reconnect.
      void session.closed
        .catch(() => undefined)
        .then(async () => connection.close());
      let announced: Uint8Array<ArrayBuffer>[] | undefined;
      // The announcement is advisory: a node that sends none, or one this console cannot read, leaves the address as it was given.
      void readAnnouncement(session)
        .then(async (hashes) => {
          announced = hashes;
          await memory.remember(node, hashes);
        })
        .catch(() => undefined);
      return {
        ...connection,
        redialAddress: () =>
          announced === undefined
            ? address
            : withPinnedHashes(address, announced),
      };
    },
    async listen(): Promise<Listener> {
      return Promise.reject(new Error(LISTEN_UNSUPPORTED));
    },
  };
}
