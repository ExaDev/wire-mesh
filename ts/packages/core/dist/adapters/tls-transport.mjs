import { frameSchema } from "../generated/protocol.mjs";
import { deriveDeviceId } from "./node-identity.mjs";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import { connect, createServer } from "node:tls";
//#region src/adapters/tls-transport.ts
const LENGTH_PREFIX_BYTES = 4;
function parseAddress(address) {
	const lastColon = address.lastIndexOf(":");
	if (lastColon === -1) throw new Error(`expected "host:port", got "${address}"`);
	return {
		host: address.slice(0, lastColon),
		port: Number(address.slice(lastColon + 1))
	};
}
function writeFrame(socket, frame) {
	const body = encode(frame, cdeEncodeOptions);
	const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
	header.writeUInt32BE(body.length, 0);
	socket.write(header);
	socket.write(body);
}
/** Reassembles length-prefixed CBOR frames from a byte stream, validating each against frameSchema before handing it to a consumer -- identical framing to createTcpTransport's own frameReader, since TLS terminates before framing and the wire shape above it is unchanged. A body that doesn't even decode as CBOR rejects the receive() iteration and destroys the connection. */
function frameReader(socket) {
	let buffer = Buffer.alloc(0);
	const pending = [];
	const waiters = [];
	let ended = false;
	let failure = null;
	function tryDrain() {
		while (buffer.length >= LENGTH_PREFIX_BYTES) {
			const bodyLength = buffer.readUInt32BE(0);
			if (buffer.length < LENGTH_PREFIX_BYTES + bodyLength) break;
			const body = buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + bodyLength);
			buffer = buffer.subarray(LENGTH_PREFIX_BYTES + bodyLength);
			let decoded;
			try {
				decoded = decode(body, cdeDecodeOptions);
			} catch (error) {
				const connectionError = error instanceof Error ? error : /* @__PURE__ */ new Error(`frame body failed to decode: ${String(error)}`);
				failAll(connectionError);
				socket.destroy(connectionError);
				return;
			}
			const result = frameSchema.safeParse(decoded);
			if (result.success) {
				const waiter = waiters.shift();
				if (waiter) waiter.resolve({
					value: result.data,
					done: false
				});
				else pending.push(result.data);
			}
		}
	}
	function endAll() {
		ended = true;
		for (const waiter of waiters.splice(0)) waiter.resolve({
			value: void 0,
			done: true
		});
	}
	function failAll(error) {
		failure = error;
		ended = true;
		for (const waiter of waiters.splice(0)) waiter.reject(error);
	}
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		tryDrain();
	});
	socket.on("end", endAll);
	socket.on("close", endAll);
	socket.on("error", () => void 0);
	return { [Symbol.asyncIterator]() {
		return { async next() {
			const next = pending.shift();
			if (next !== void 0) return Promise.resolve({
				value: next,
				done: false
			});
			if (failure !== null) return Promise.reject(failure);
			if (ended) return Promise.resolve({
				value: void 0,
				done: true
			});
			return new Promise((resolve, reject) => {
				waiters.push({
					resolve,
					reject
				});
			});
		} };
	} };
}
/** Authenticates the socket's peer, if it presented a certificate: derives a device-id from the certificate's own raw public-key bytes -- never from anything the peer merely claims -- and returns undefined only when no certificate was presented at all (never on a mismatch; there is nothing to mismatch against at this layer, only a fact to report). Node's TLS layer has already verified the peer actually holds the matching private key by the time a socket reaches this point, so this device-id is cryptographically backed, not self-asserted. */
async function authenticatedPeerDeviceId(socket) {
	const cert = socket.getPeerCertificate();
	if (Object.keys(cert).length === 0 || !("pubkey" in cert)) return;
	return deriveDeviceId(cert.pubkey);
}
function wrapSocket(socket, peerDeviceId) {
	const frames = frameReader(socket);
	return {
		send: async (frame) => {
			writeFrame(socket, frame);
			return Promise.resolve();
		},
		receive: () => frames,
		close: async () => new Promise((resolve) => {
			socket.end(() => {
				resolve();
			});
		}),
		peerDeviceId,
		unref: () => {
			socket.unref();
		}
	};
}
/** A Node tls.TLSSocket-based Transport: the identical length-prefixed CBOR framing createTcpTransport uses, but over mutually-authenticated TLS -- both sides always present the certificate from the identity passed in, and rejectUnauthorized stays false deliberately (this is certificate-pinning by device-id, the Syncthing trust model, not a CA hierarchy) while Connection.peerDeviceId carries the one thing that actually matters: what the presented certificate cryptographically proves the peer holds the key for. */
function createTlsTransport(identity) {
	const tlsOptions = {
		key: identity.privateKeyPem,
		cert: identity.certificatePem,
		rejectUnauthorized: false
	};
	return {
		async connect(address) {
			const { host, port } = parseAddress(address);
			const socket = await new Promise((resolve, reject) => {
				const s = connect({
					...tlsOptions,
					host,
					port
				}, () => {
					resolve(s);
				});
				s.once("error", reject);
			});
			return wrapSocket(socket, await authenticatedPeerDeviceId(socket));
		},
		async listen(address, onConnection) {
			const { host, port } = parseAddress(address);
			return new Promise((resolve, reject) => {
				const server = createServer({
					...tlsOptions,
					requestCert: true
				}, (socket) => {
					authenticatedPeerDeviceId(socket).then((peerDeviceId) => {
						onConnection(wrapSocket(socket, peerDeviceId));
					});
				});
				server.once("error", reject);
				server.listen(port, host, () => {
					const bound = server.address();
					if (bound === null || typeof bound === "string") {
						reject(/* @__PURE__ */ new Error("listener did not report a bound address"));
						return;
					}
					resolve({
						close: async () => new Promise((resolveClose) => {
							server.close(() => {
								resolveClose();
							});
						}),
						address: `${bound.address}:${String(bound.port)}`,
						unref: () => {
							server.unref();
						}
					});
				});
			});
		}
	};
}
//#endregion
export { createTlsTransport };
