import { connect as tlsConnect, createServer, type TLSSocket } from "node:tls";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  frameSchema,
  type DeviceId,
  type Frame,
} from "../generated/protocol.js";
import type { Connection, Listener, Transport } from "../ports/transport.js";
import { deriveDeviceId } from "./node-identity.js";

const LENGTH_PREFIX_BYTES = 4;

export interface TlsIdentity {
  certificatePem: string;
  privateKeyPem: string;
}

function parseAddress(address: string): { host: string; port: number } {
  const lastColon = address.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(`expected "host:port", got "${address}"`);
  }
  return {
    host: address.slice(0, lastColon),
    port: Number(address.slice(lastColon + 1)),
  };
}

function writeFrame(socket: TLSSocket, frame: Frame): void {
  const body = encode(frame, cdeEncodeOptions);
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32BE(body.length, 0);
  socket.write(header);
  socket.write(body);
}

/** Reassembles length-prefixed CBOR frames from a byte stream, validating each against frameSchema before handing it to a consumer -- identical framing to createTcpTransport's own frameReader, since TLS terminates before framing and the wire shape above it is unchanged. A body that doesn't even decode as CBOR rejects the receive() iteration and destroys the connection. */
function frameReader(socket: TLSSocket): AsyncIterable<Frame> {
  let buffer = Buffer.alloc(0);
  const pending: Frame[] = [];
  const waiters: {
    resolve: (result: IteratorResult<Frame>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let ended = false;
  let failure: Error | null = null;

  function tryDrain(): void {
    while (buffer.length >= LENGTH_PREFIX_BYTES) {
      const bodyLength = buffer.readUInt32BE(0);
      if (buffer.length < LENGTH_PREFIX_BYTES + bodyLength) break;
      const body = buffer.subarray(
        LENGTH_PREFIX_BYTES,
        LENGTH_PREFIX_BYTES + bodyLength,
      );
      buffer = buffer.subarray(LENGTH_PREFIX_BYTES + bodyLength);

      let decoded: unknown;
      try {
        // cbor2's decode() mirrors its input's own class for nested byte-string values: fed a Buffer, it slices out Buffer instances, not plain Uint8Array -- and its own encode() then fails to recognise a Buffer as a byte string at all (it falls through to encoding it as a generic object), silently corrupting any later re-encode of a decoded byte-string field. A capability token's own signature verification does exactly that re-encode (COSE's Sig_structure, built from the token's own protected-header and payload byte strings), so decoding straight off this socket's Buffer would make every real, wire-received token fail signature verification despite carrying perfectly correct bytes. Normalising to a plain Uint8Array view first (same range, same backing memory, just the base class cbor2's encoder actually recognises) avoids the whole class of bug, matching frame-codec.ts's own `new Uint8Array(data)` normalisation for exactly this reason.
        decoded = decode(
          new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
          cdeDecodeOptions,
        );
      } catch (error) {
        const connectionError =
          error instanceof Error
            ? error
            : new Error(`frame body failed to decode: ${String(error)}`);
        failAll(connectionError);
        socket.destroy(connectionError);
        return;
      }
      const result = frameSchema.safeParse(decoded);
      if (result.success) {
        const waiter = waiters.shift();
        if (waiter) {
          waiter.resolve({ value: result.data, done: false });
        } else {
          pending.push(result.data);
        }
      }
    }
  }

  function endAll(): void {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  function failAll(error: Error): void {
    failure = error;
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    tryDrain();
  });
  socket.on("end", endAll);
  socket.on("close", endAll);
  socket.on("error", () => undefined);

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Frame>> {
          const next = pending.shift();
          if (next !== undefined) {
            return Promise.resolve({ value: next, done: false });
          }
          if (failure !== null) {
            return Promise.reject(failure);
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
      };
    },
  };
}

/** Authenticates the socket's peer, if it presented a certificate: derives a device-id from the certificate's own raw public-key bytes -- never from anything the peer merely claims -- and returns undefined only when no certificate was presented at all (never on a mismatch; there is nothing to mismatch against at this layer, only a fact to report). Node's TLS layer has already verified the peer actually holds the matching private key by the time a socket reaches this point, so this device-id is cryptographically backed, not self-asserted. */
async function authenticatedPeerDeviceId(
  socket: TLSSocket,
): Promise<DeviceId | undefined> {
  const cert = socket.getPeerCertificate();
  // Node's own type declares every PeerCertificate field non-optional, but the documented behaviour when no certificate was presented is an empty object -- not null/undefined and not a Buffer-typed `pubkey`. Detect that real shape rather than trusting the declared type.
  if (Object.keys(cert).length === 0 || !("pubkey" in cert)) {
    return undefined;
  }
  return deriveDeviceId(cert.pubkey);
}

function wrapSocket(
  socket: TLSSocket,
  peerDeviceId: DeviceId | undefined,
): Connection {
  const frames = frameReader(socket);
  return {
    send: async (frame) => {
      writeFrame(socket, frame);
      return Promise.resolve();
    },
    receive: () => frames,
    close: async () =>
      new Promise((resolve) => {
        socket.end(() => {
          resolve();
        });
      }),
    // Connection.peerDeviceId is `?: DeviceId`, not `?: DeviceId | undefined` -- under exactOptionalPropertyTypes, the two are genuinely different types, and a plain `peerDeviceId,` shorthand here would always include the key (even when its value is undefined), which the stricter type refuses. Spreading conditionally leaves the key entirely absent instead, matching what "no authenticated peer" actually means: a fact this side has nothing to report, not a reported fact whose value happens to be undefined.
    ...(peerDeviceId !== undefined ? { peerDeviceId } : {}),
    unref: () => {
      socket.unref();
    },
  };
}

/** A Node tls.TLSSocket-based Transport: the identical length-prefixed CBOR framing createTcpTransport uses, but over mutually-authenticated TLS -- both sides always present the certificate from the identity passed in, and rejectUnauthorized stays false deliberately (this is certificate-pinning by device-id, the Syncthing trust model, not a CA hierarchy) while Connection.peerDeviceId carries the one thing that actually matters: what the presented certificate cryptographically proves the peer holds the key for. */
export function createTlsTransport(identity: Readonly<TlsIdentity>): Transport {
  const tlsOptions = {
    key: identity.privateKeyPem,
    cert: identity.certificatePem,
    rejectUnauthorized: false,
  };
  return {
    async connect(address) {
      const { host, port } = parseAddress(address);
      const socket = await new Promise<TLSSocket>((resolve, reject) => {
        const s = tlsConnect({ ...tlsOptions, host, port }, () => {
          resolve(s);
        });
        s.once("error", reject);
      });
      const peerDeviceId = await authenticatedPeerDeviceId(socket);
      return wrapSocket(socket, peerDeviceId);
    },
    async listen(address, onConnection): Promise<Listener> {
      const { host, port } = parseAddress(address);
      return new Promise((resolve, reject) => {
        const server = createServer(
          { ...tlsOptions, requestCert: true },
          (socket) => {
            void authenticatedPeerDeviceId(socket).then((peerDeviceId) => {
              onConnection(wrapSocket(socket, peerDeviceId));
            });
          },
        );
        server.once("error", reject);
        server.listen(port, host, () => {
          const bound = server.address();
          if (bound === null || typeof bound === "string") {
            reject(new Error("listener did not report a bound address"));
            return;
          }
          const listener: Listener = {
            close: async () =>
              new Promise((resolveClose) => {
                server.close(() => {
                  resolveClose();
                });
              }),
            address: `${bound.address}:${String(bound.port)}`,
            unref: () => {
              server.unref();
            },
          };
          resolve(listener);
        });
      });
    },
  };
}
