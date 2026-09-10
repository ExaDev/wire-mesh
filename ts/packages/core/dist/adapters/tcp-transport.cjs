Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const require_generated_protocol = require("../generated/protocol.cjs");
let cbor2 = require("cbor2");
let node_net = require("node:net");
//#region src/adapters/tcp-transport.ts
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
	const body = (0, cbor2.encode)(frame, cbor2.cdeEncodeOptions);
	const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
	header.writeUInt32BE(body.length, 0);
	socket.write(header);
	socket.write(body);
}
/** Reassembles length-prefixed CBOR frames from a byte stream, validating each against frameSchema before handing it to a consumer. A body that doesn't even decode as CBOR rejects the receive() iteration and destroys the connection -- hostile wire input is a connection-level failure, surfaced through the Transport port rather than crashing the process or being silently swallowed. */
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
				decoded = (0, cbor2.decode)(body, cbor2.cdeDecodeOptions);
			} catch (error) {
				const connectionError = error instanceof Error ? error : /* @__PURE__ */ new Error(`frame body failed to decode: ${String(error)}`);
				failAll(connectionError);
				socket.destroy(connectionError);
				return;
			}
			const result = require_generated_protocol.frameSchema.safeParse(decoded);
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
	/** Ends the iteration with the connection-level error: pending and future next() calls reject, so a consumer iterating receive() sees the failure where it consumed the stream. */
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
function wrapSocket(socket) {
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
		})
	};
}
/** A Node net.Socket-based Transport: length-prefixed, CBOR-encoded frames over plain TCP -- matching Cascade's own transport shape, since interop with Cascade nodes is wire-mesh's stated goal. Framing (not TLS) is this adapter's own concern; a TLS-terminated variant is a separate adapter behind the same Transport contract. */
function createTcpTransport() {
	return {
		async connect(address) {
			const { host, port } = parseAddress(address);
			return new Promise((resolve, reject) => {
				const socket = (0, node_net.connect)({
					host,
					port
				});
				socket.once("connect", () => {
					resolve(wrapSocket(socket));
				});
				socket.once("error", reject);
			});
		},
		async listen(address, onConnection) {
			const { host, port } = parseAddress(address);
			return new Promise((resolve, reject) => {
				const server = (0, node_net.createServer)((socket) => {
					onConnection(wrapSocket(socket));
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
						address: `${bound.address}:${String(bound.port)}`
					});
				});
			});
		}
	};
}
//#endregion
exports.createTcpTransport = createTcpTransport;
