Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
	const pairingsByInitiator = /* @__PURE__ */ new Map();
	const pairingsByTarget = /* @__PURE__ */ new Map();
	function forgetConnection(connection) {
		for (const [key, registration] of devices) if (registration.connection === connection) devices.delete(key);
		forgetPairingsOf(connection);
	}
	/** Removes every pairing the connection belongs to -- in either role, and both directions of each. A connection can be the initiator of one pairing and the target of a different one at the same time, so covering both roles is what makes a teardown total. */
	function forgetPairingsOf(connection) {
		const asInitiator = pairingsByInitiator.get(connection);
		if (asInitiator) {
			pairingsByInitiator.delete(connection);
			pairingsByTarget.delete(asInitiator.target);
		}
		const asTarget = pairingsByTarget.get(connection);
		if (asTarget) {
			pairingsByTarget.delete(connection);
			pairingsByInitiator.delete(asTarget.initiator);
		}
	}
	function deviceOf(connection) {
		for (const registration of devices.values()) if (registration.connection === connection) return registration.device;
		return null;
	}
	async function handleFrame(connection, frame) {
		if (frame.type === "gossip") {
			for (const advert of frame.peers) devices.set(deviceKey(advert.device), {
				connection,
				device: advert.device
			});
			return;
		}
		if (frame.type === "relay-connect") {
			const registration = devices.get(deviceKey(frame["target-device"]));
			if (!registration || registration.connection === connection) return;
			const initiatorDevice = deviceOf(connection);
			if (initiatorDevice === null) return;
			forgetPairingsOf(connection);
			forgetPairingsOf(registration.connection);
			await registration.connection.send({
				type: "relay-inbound",
				"source-device": initiatorDevice
			});
			const pairing = {
				initiator: connection,
				initiatorDevice,
				target: registration.connection
			};
			pairingsByInitiator.set(connection, pairing);
			pairingsByTarget.set(registration.connection, pairing);
			return;
		}
		if (frame.type === "relay-data") {
			const pairing = pairingsByInitiator.get(connection) ?? pairingsByTarget.get(connection);
			if (!pairing) return;
			await (pairing.initiator === connection ? pairing.target : pairing.initiator).send(frame);
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
			pairingsByInitiator.clear();
			pairingsByTarget.clear();
		}
	};
}
//#endregion
exports.createRelayHub = createRelayHub;
