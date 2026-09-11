import { deviceIdToHex } from "./device-id.mjs";
import { negotiate } from "./handshake.mjs";
import { messageFromFrame, tryDecodeFrame } from "../adapters/frame-codec.mjs";
//#region src/domain/mesh-session.ts
const MS_PER_SECOND = 1e3;
/** How long to wait for the node's handshake before calling it unanswered. A relay-only node never sends one; that is a state to display, not an error. */
const HANDSHAKE_TIMEOUT_MS = 3e3;
function localHandshake(domains) {
	return {
		type: "handshake",
		version: 1,
		domains: [...domains]
	};
}
/**
* Builds the connection-agnostic session state machine and its public MeshSession surface. dial is null for a session that can never (re)connect on its own -- acceptMeshSession's case, where the one connection it will ever have already exists by construction and reconnect therefore cannot apply (only the remote redialing, and being accepted again, produces a fresh connection). createMeshSession supplies dial as transport.connect so its own connect()/reconnect behaviour is unchanged from before this was factored out.
*/
function createSessionCore(identity, clock, reconnect, dial, onPeerAdvert) {
	let connection = null;
	let state = { status: "idle" };
	let handshake = { status: "pending" };
	const directory = /* @__PURE__ */ new Map();
	const frameLog = [];
	let feedCancelled = false;
	const eventWaiters = [];
	const eventBacklog = [];
	let handshakeTimer = null;
	let reconnectTimer = null;
	let attempt = 0;
	let currentToken = null;
	let nextRequestId = 0;
	let relayPeerDevice = null;
	const pendingManageRequests = /* @__PURE__ */ new Map();
	const incomingWaiters = [];
	const incomingBacklog = [];
	function snapshot() {
		return {
			state,
			directory: [...directory.values()],
			frameLog: [...frameLog]
		};
	}
	function emit() {
		const event = snapshot();
		const waiter = eventWaiters.shift();
		if (waiter) waiter(event);
		else eventBacklog.push(event);
	}
	function emitIncomingManageRequest(request) {
		const waiter = incomingWaiters.shift();
		if (waiter) waiter(request);
		else incomingBacklog.push(request);
	}
	function rejectPendingManageRequests(reason) {
		for (const pending of pendingManageRequests.values()) pending.reject(new Error(reason));
		pendingManageRequests.clear();
	}
	function buildManageRequest(command, scope, tokenOverride) {
		const requestId = nextRequestId;
		nextRequestId += 1;
		const token = tokenOverride ?? currentToken;
		return {
			type: "manage-request",
			"request-id": requestId,
			command,
			scope,
			...token !== null ? { token } : {}
		};
	}
	/** Sends a frame, wrapping it as relay-data first when viaRelay is set -- the single choke point every outbound manage-request/manage-response passes through, so a consumer of sendManageRequest/respond never needs its own relay-wrapping logic. */
	async function transmit(frame, viaRelay) {
		if (connection === null) throw new Error("not connected");
		if (viaRelay) {
			const relayFrame = {
				type: "relay-data",
				payload: messageFromFrame(frame)
			};
			await connection.send(relayFrame);
			return;
		}
		await connection.send(frame);
	}
	function applyManageResponse(frame) {
		const requestId = frame["request-id"];
		const pending = pendingManageRequests.get(requestId);
		if (pending !== void 0) {
			pendingManageRequests.delete(requestId);
			pending.resolve(frame.outcome);
		}
	}
	function applyManageRequest(frame, viaRelay) {
		const requestId = frame["request-id"];
		const fromDevice = viaRelay && relayPeerDevice !== null ? relayPeerDevice : void 0;
		emitIncomingManageRequest({
			requestId,
			command: frame.command,
			scope: frame.scope,
			...frame.token !== void 0 ? { token: frame.token } : {},
			...fromDevice !== void 0 ? { fromDevice } : {},
			respond: async (outcome) => {
				const response = {
					type: "manage-response",
					"request-id": requestId,
					outcome
				};
				frameLog.push({
					direction: "sent",
					frame: response
				});
				await transmit(response, viaRelay);
				emit();
			}
		});
	}
	function applyFrame(frame) {
		if (frame.type === "relay-data") {
			const inner = tryDecodeFrame(frame.payload);
			if (inner !== null && (inner.type === "manage-request" || inner.type === "manage-response")) {
				frameLog.push({
					direction: "received",
					frame: inner
				});
				if (inner.type === "manage-response") applyManageResponse(inner);
				else applyManageRequest(inner, true);
				return;
			}
			frameLog.push({
				direction: "received",
				frame
			});
			return;
		}
		frameLog.push({
			direction: "received",
			frame
		});
		if (frame.type === "handshake") applyRemoteHandshake(frame);
		else if (frame.type === "gossip") for (const advert of frame.peers) {
			directory.set(deviceIdToHex(advert.device), {
				device: advert.device,
				advert
			});
			onPeerAdvert?.(advert);
		}
		else if (frame.type === "relay-inbound") relayPeerDevice = frame["source-device"];
		else if (frame.type === "manage-response") applyManageResponse(frame);
		else if (frame.type === "manage-request") applyManageRequest(frame, false);
	}
	/** Establishes a relay-connect pairing to targetDevice if this session isn't already paired with it -- a no-op when it already is, whether that pairing was established by this session's own prior relay-connect (initiator role) or learned from an incoming relay-inbound (target role, replying back to whoever dialed it). relay-connect has no ack frame: the initiator proceeds to relay-data right after sending it. */
	async function ensureRelayPairing(targetDevice) {
		if (connection === null) throw new Error("not connected");
		if (relayPeerDevice !== null && deviceIdToHex(relayPeerDevice) === deviceIdToHex(targetDevice)) return;
		const relayConnect = {
			type: "relay-connect",
			"target-device": targetDevice
		};
		frameLog.push({
			direction: "sent",
			frame: relayConnect
		});
		await connection.send(relayConnect);
		relayPeerDevice = targetDevice;
		emit();
	}
	let localHandshakeSent = localHandshake([]);
	function applyRemoteHandshake(remote) {
		if (handshake.status !== "pending") return;
		if (handshakeTimer !== null) {
			clearTimeout(handshakeTimer);
			handshakeTimer = null;
		}
		const result = negotiate(localHandshakeSent, remote);
		handshake = result.ok ? {
			status: "negotiated",
			version: result.version,
			sharedDomains: result.sharedDomains
		} : {
			status: "rejected",
			reason: "no shared domains or version"
		};
		if (state.status === "connected") state = {
			...state,
			handshake
		};
	}
	function handleDisconnect(reason, address, localDomains) {
		if (feedCancelled) return;
		rejectPendingManageRequests("disconnected before a response arrived");
		if (reconnect !== null && attempt < reconnect.maxAttempts) {
			attempt += 1;
			const currentAttempt = attempt;
			state = {
				status: "reconnecting",
				address,
				attempt: currentAttempt,
				reason
			};
			emit();
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				doConnect(address, localDomains).catch((error) => {
					handleDisconnect(error instanceof Error ? error.message : String(error), address, localDomains);
				});
			}, reconnect.delayMs(currentAttempt));
			return;
		}
		state = {
			status: "closed",
			address,
			reason
		};
		emit();
	}
	async function consume(link, address, localDomains) {
		for await (const frame of link.receive()) {
			if (feedCancelled) return;
			applyFrame(frame);
			emit();
		}
		if (state.status === "connected") handleDisconnect("node closed the connection", address, localDomains);
	}
	/** Everything a connection needs once it exists, regardless of whether it was dialled (createMeshSession's own doConnect, below) or handed over already established (acceptMeshSession): send this side's handshake and self-advert, arm the handshake timeout, and start consuming frames. The two entry points differ only in how link itself came to exist and what address means for it -- a real dial target for one, a caller-chosen label for the other, since the Connection/Transport ports expose no remote-address concept of their own for an accepted connection. */
	async function wireUpConnection(link, address, localDomains) {
		connection = link;
		localHandshakeSent = localHandshake(localDomains);
		handshake = { status: "pending" };
		state = {
			status: "connected",
			address,
			handshake
		};
		frameLog.push({
			direction: "sent",
			frame: localHandshakeSent
		});
		await connection.send(localHandshakeSent);
		emit();
		const selfAdvert = {
			type: "gossip",
			peers: [{
				device: identity.deviceId,
				addresses: [],
				"snapshot-seconds": Math.floor(clock.now() / MS_PER_SECOND)
			}]
		};
		frameLog.push({
			direction: "sent",
			frame: selfAdvert
		});
		await connection.send(selfAdvert);
		emit();
		handshakeTimer = setTimeout(() => {
			handshakeTimer = null;
			if (handshake.status === "pending") {
				handshake = { status: "unanswered" };
				if (state.status === "connected") state = {
					...state,
					handshake
				};
				emit();
			}
		}, HANDSHAKE_TIMEOUT_MS);
		consume(connection, address, localDomains).catch((error) => {
			if (state.status === "connected") handleDisconnect(error instanceof Error ? error.message : String(error), address, localDomains);
		});
	}
	async function doConnect(address, localDomains) {
		if (dial === null) throw new Error("this session is already connected; there is nothing to dial");
		if (handshakeTimer !== null) {
			clearTimeout(handshakeTimer);
			handshakeTimer = null;
		}
		state = {
			status: "connecting",
			address
		};
		emit();
		const link = await dial(address);
		if (feedCancelled) {
			await link.close();
			return;
		}
		await wireUpConnection(link, address, localDomains);
	}
	return {
		wireUpConnection,
		session: {
			events: { [Symbol.asyncIterator]() {
				return { next: async () => new Promise((resolve) => {
					const backlogEvent = eventBacklog.shift();
					if (backlogEvent) resolve({
						value: backlogEvent,
						done: false
					});
					else eventWaiters.push((event) => {
						resolve({
							value: event,
							done: false
						});
					});
				}) };
			} },
			incomingManageRequests: { [Symbol.asyncIterator]() {
				return { next: async () => new Promise((resolve) => {
					const backlogRequest = incomingBacklog.shift();
					if (backlogRequest) resolve({
						value: backlogRequest,
						done: false
					});
					else incomingWaiters.push((request) => {
						resolve({
							value: request,
							done: false
						});
					});
				}) };
			} },
			async connect(address, localDomains) {
				if (connection !== null) throw new Error("a session connects once; create a new one to reconnect");
				attempt = 0;
				await doConnect(address, localDomains);
			},
			async sendPing() {
				if (connection === null || state.status !== "connected") throw new Error("not connected");
				const ping = { type: "ping" };
				frameLog.push({
					direction: "sent",
					frame: ping
				});
				await connection.send(ping);
				emit();
			},
			setToken(token) {
				currentToken = token;
			},
			async sendManageRequest(command, scope, targetDevice, token) {
				if (connection === null || state.status !== "connected") throw new Error("not connected");
				if (targetDevice !== void 0) await ensureRelayPairing(targetDevice);
				const frame = buildManageRequest(command, scope, token);
				const outcome = new Promise((resolve, reject) => {
					pendingManageRequests.set(frame["request-id"], {
						resolve,
						reject
					});
				});
				frameLog.push({
					direction: "sent",
					frame
				});
				await transmit(frame, targetDevice !== void 0);
				emit();
				return outcome;
			},
			async close() {
				feedCancelled = true;
				if (handshakeTimer !== null) {
					clearTimeout(handshakeTimer);
					handshakeTimer = null;
				}
				if (reconnectTimer !== null) {
					clearTimeout(reconnectTimer);
					reconnectTimer = null;
				}
				rejectPendingManageRequests("connection closed before a response arrived");
				if (connection !== null) await connection.close();
				if (state.status === "connected" || state.status === "connecting" || state.status === "reconnecting") state = {
					status: "closed",
					address: state.address,
					reason: "closed by you"
				};
				emit();
			}
		}
	};
}
function createMeshSession(transport, identity, clock = { now: () => Date.now() }, reconnect = null) {
	const { session } = createSessionCore(identity, clock, reconnect, async (address) => transport.connect(address));
	return session;
}
/** Wires an already-accepted Connection up as a full MeshSession, mirroring exactly what createMeshSession's own dial path does once a connection exists (send handshake, send self-advert, negotiate, consume frames) -- the wire-mesh#45 prerequisite agent-comms needs, since its peers both listen and dial rather than only ever dialing the way web-console's own console UI does. Reconnect does not apply here: if this connection drops, only the remote redialing and being accepted again produces a new connection, and therefore a new session -- there is nothing on this side to retry. */
async function acceptMeshSession(connection, identity, localDomains, options = {}) {
	const clock = options.clock ?? { now: () => Date.now() };
	let resolvePeerDeviceId = null;
	const peerDeviceId = new Promise((resolve) => {
		resolvePeerDeviceId = resolve;
	});
	let peerDeviceIdResolved = false;
	const { session, wireUpConnection } = createSessionCore(identity, clock, null, null, (advert) => {
		if (peerDeviceIdResolved) return;
		peerDeviceIdResolved = true;
		resolvePeerDeviceId?.(advert.device);
	});
	await wireUpConnection(connection, options.label ?? "accepted", localDomains);
	return {
		...session,
		peerDeviceId
	};
}
//#endregion
export { HANDSHAKE_TIMEOUT_MS, acceptMeshSession, createMeshSession };
