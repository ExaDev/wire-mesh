//#region src/domain/relay-hub.ts
const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;
function deviceKey(device) {
	let key = "";
	for (const byte of device) key += byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0");
	return key;
}
function createRelayHub() {
	const devices = /* @__PURE__ */ new Map();
	const connectionDevice = /* @__PURE__ */ new Map();
	const pairings = /* @__PURE__ */ new Map();
	const mostRecentPairing = /* @__PURE__ */ new Map();
	function pairingsOf(connection) {
		const existing = pairings.get(connection);
		if (existing) return existing;
		const created = /* @__PURE__ */ new Map();
		pairings.set(connection, created);
		return created;
	}
	function addPairing(a, aDevice, b, bDevice) {
		pairingsOf(a).set(deviceKey(bDevice), b);
		pairingsOf(b).set(deviceKey(aDevice), a);
		mostRecentPairing.set(a, b);
		mostRecentPairing.set(b, a);
	}
	function forgetConnection(connection) {
		for (const [key, registration] of devices) if (registration.connection === connection) devices.delete(key);
		const ownDevice = connectionDevice.get(connection);
		connectionDevice.delete(connection);
		mostRecentPairing.delete(connection);
		const own = pairings.get(connection);
		if (own) {
			for (const peer of own.values()) {
				const peerOwn = pairings.get(peer);
				if (peerOwn && ownDevice !== void 0) peerOwn.delete(deviceKey(ownDevice));
				if (mostRecentPairing.get(peer) === connection) mostRecentPairing.delete(peer);
			}
			pairings.delete(connection);
		}
	}
	async function handleFrame(connection, frame) {
		if (frame.type === "gossip") {
			for (const advert of frame.peers) devices.set(deviceKey(advert.device), {
				connection,
				device: advert.device
			});
			for (const registration of devices.values()) if (registration.connection === connection) {
				connectionDevice.set(connection, registration.device);
				break;
			}
			return;
		}
		if (frame.type === "relay-connect") {
			const registration = devices.get(deviceKey(frame["target-device"]));
			if (!registration || registration.connection === connection) return;
			const initiatorDevice = connectionDevice.get(connection);
			if (initiatorDevice === void 0) return;
			addPairing(connection, initiatorDevice, registration.connection, registration.device);
			await registration.connection.send({
				type: "relay-inbound",
				"source-device": initiatorDevice
			});
			return;
		}
		if (frame.type === "relay-data") {
			const own = pairings.get(connection);
			const toDevice = frame["to-device"];
			const peer = toDevice !== void 0 ? own?.get(deviceKey(toDevice)) : mostRecentPairing.get(connection);
			if (!peer) return;
			const senderDevice = connectionDevice.get(connection);
			if (senderDevice === void 0) return;
			await peer.send({
				type: "relay-data",
				payload: frame.payload,
				"from-device": senderDevice
			});
			return;
		}
	}
	return {
		async handleConnection(connection) {
			try {
				for await (const frame of connection.receive()) await handleFrame(connection, frame);
			} catch {} finally {
				forgetConnection(connection);
			}
		},
		stop() {
			devices.clear();
			connectionDevice.clear();
			pairings.clear();
			mostRecentPairing.clear();
		}
	};
}
//#endregion
export { createRelayHub };
