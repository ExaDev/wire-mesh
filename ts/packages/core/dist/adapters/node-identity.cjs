Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let node_crypto = require("node:crypto");
//#region src/adapters/node-identity.ts
const ES256 = -7;
const EDDSA = -8;
function algParams(alg) {
	if (alg === ES256) return {
		name: "ECDSA",
		hash: "SHA-256"
	};
	if (alg === EDDSA) return { name: "Ed25519" };
	throw new Error(`unsupported identity-key alg ${String(alg)}`);
}
/** Copies into a fresh, non-shared, whole-buffer Uint8Array -- Web Crypto's BufferSource parameters reject a view over a SharedArrayBuffer or a sub-range view, neither of which a caller-supplied Uint8Array is guaranteed not to be. */
function toBufferSource(bytes) {
	return Uint8Array.from(bytes);
}
async function importPublicKey(key) {
	if (key.alg === ES256) return node_crypto.webcrypto.subtle.importKey("raw", toBufferSource(key["public-key"]), {
		name: "ECDSA",
		namedCurve: "P-256"
	}, false, ["verify"]);
	if (key.alg === EDDSA) return node_crypto.webcrypto.subtle.importKey("raw", toBufferSource(key["public-key"]), { name: "Ed25519" }, false, ["verify"]);
	throw new Error(`unsupported identity-key alg ${String(key.alg)}`);
}
async function deriveDeviceId(publicKey) {
	return new Uint8Array(await node_crypto.webcrypto.subtle.digest("SHA-256", toBufferSource(publicKey)));
}
async function verifyWithPublicKey(key, message, signature) {
	const cryptoKey = await importPublicKey(key);
	return node_crypto.webcrypto.subtle.verify(algParams(key.alg), cryptoKey, toBufferSource(signature), toBufferSource(message));
}
/**
* Builds an IdentityPort from a Web Crypto private key already generated for this node -- ECDSA P-256 (alg -7) or Ed25519 (alg -8), the two algorithms identity-key.alg actually carries in the spec's own conformance vectors. Device-id derivation and signature verification are pure functions of the given key bytes (exported separately above), so they work for an arbitrary issuer-key too, not just this node's own.
*/
async function createNodeIdentity(privateKey, publicKeyBytes, alg) {
	const identityKey = {
		alg,
		"public-key": toBufferSource(publicKeyBytes)
	};
	return {
		deviceId: await deriveDeviceId(publicKeyBytes),
		identityKey,
		async sign(message) {
			const signature = await node_crypto.webcrypto.subtle.sign(algParams(alg), privateKey, toBufferSource(message));
			return new Uint8Array(signature);
		},
		verify: verifyWithPublicKey,
		deriveDeviceId
	};
}
//#endregion
exports.createNodeIdentity = createNodeIdentity;
exports.deriveDeviceId = deriveDeviceId;
exports.verifyWithPublicKey = verifyWithPublicKey;
