import { j as IdentityKey, v as DeviceId } from "../protocol-D8yeaquP.mjs";
import { IdentityPort } from "../ports/identity.mjs";
import { webcrypto } from "node:crypto";
//#region src/adapters/node-identity.d.ts
export declare function deriveDeviceId(publicKey: Uint8Array): Promise<DeviceId>;
export declare function verifyWithPublicKey(key: IdentityKey, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
/**
 * Builds an IdentityPort from a Web Crypto private key already generated for this node -- ECDSA P-256 (alg -7) or Ed25519 (alg -8), the two algorithms identity-key.alg actually carries in the spec's own conformance vectors. Device-id derivation and signature verification are pure functions of the given key bytes (exported separately above), so they work for an arbitrary issuer-key too, not just this node's own.
 */
export declare function createNodeIdentity(privateKey: webcrypto.CryptoKey, publicKeyBytes: Uint8Array, alg: number): Promise<IdentityPort>;
//#endregion