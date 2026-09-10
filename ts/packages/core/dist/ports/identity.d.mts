import { k as IdentityKey, v as DeviceId } from "../protocol-DX0RGNQS.mjs";
//#region src/ports/identity.d.ts
/**
 * Wraps the local node's own identity plus the signing/verification primitives capability-token handling needs -- never hardcoded to one crypto library's own API shape (Node's webcrypto, a WASM implementation, a hardware key, etc. can all satisfy this same contract).
 */
export interface IdentityPort {
  readonly deviceId: DeviceId;
  readonly identityKey: IdentityKey;
  /** Signs an already-assembled message (e.g. a COSE Sig_structure) with the local node's own private key. Always a fresh buffer, never a view into shared or offset memory -- directly usable as a CapabilityToken tuple element without further normalisation. */
  sign: (message: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
  /** Verifies a signature against an arbitrary identity-key -- not necessarily the local node's own, since capability-token verification checks a token's issuer-key. */
  verify: (key: IdentityKey, message: Uint8Array, signature: Uint8Array) => Promise<boolean>;
  /** Derives the device-id an arbitrary public key would produce (SHA-256 of the raw public-key bytes -- never a certificate's own DER encoding, the bug both Cascade and agent-comms had to fix). Used to check a token's self-certifying issuer-key against its claimed issuer, not just the local node's own identity. */
  deriveDeviceId: (publicKey: Uint8Array) => Promise<DeviceId>;
}
//#endregion