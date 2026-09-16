import type { DeviceId, IdentityKey } from "../generated/protocol.js";

/**
 * Wraps the local node's own identity plus the signing/verification primitives capability-token handling needs -- never hardcoded to one crypto library's own API shape (Node's webcrypto, a WASM implementation, a hardware key, etc. can all satisfy this same contract).
 */
export interface IdentityPort {
  readonly deviceId: DeviceId;
  readonly identityKey: IdentityKey;
  /** Signs an already-assembled message (e.g. a COSE Sig_structure) with the local node's own private key. Always a fresh buffer, never a view into shared or offset memory -- directly usable as a CapabilityToken tuple element without further normalisation. */
  sign: (message: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
  /** Verifies a signature against an arbitrary identity-key -- not necessarily the local node's own, since capability-token verification checks a token's issuer-key. */
  verify: (
    key: IdentityKey,
    message: Uint8Array,
    signature: Uint8Array,
  ) => Promise<boolean>;
  /** Derives the device-id an arbitrary public key would produce (SHA-256 of the raw public-key bytes -- never a certificate's own DER encoding, the bug both Cascade and agent-comms had to fix). Used to check a token's self-certifying issuer-key against its claimed issuer, not just the local node's own identity. */
  deriveDeviceId: (publicKey: Uint8Array) => Promise<DeviceId>;
  /** Derives a raw ECDH shared secret against a peer's identity-key, the asymmetric half of room.rekey's own ECIES key-wrapping construction (wire-mesh#141) -- HKDF and AES-256-GCM, the symmetric half, need no port since they operate on plain bytes already in hand, with no platform-specific key custody involved. Optional, not a method every implementation must throw from: ECDH is only defined here for an ES256 (P-256) identity-key, so an Ed25519-only identity genuinely cannot support it, the same "some identities can do this, some can't" reality `sign`'s own two-algorithm dispatch already reflects. A caller that needs this and finds it absent must fail closed, never substitute a different construction. Returns the raw shared-secret bytes, NOT yet an encryption key -- always pass through HKDF first, never use ECDH output directly as a symmetric key. */
  deriveSharedSecret?: (
    peerKey: IdentityKey,
  ) => Promise<Uint8Array<ArrayBuffer>>;
}
