/**
 * The symmetric half of room.rekey's own ECIES key-wrapping construction (wire-mesh#141): HKDF-SHA256 turning a raw ECDH shared secret into a per-(room, key-epoch) AES-256-GCM wrapping key, and AES-256-GCM itself for wrapping a room's content-encryption key and for encrypting a room-notice's own content under it. The asymmetric half (producing the shared secret) lives behind IdentityPort.deriveSharedSecret instead -- these functions operate only on plain bytes already in hand, with no platform-specific key-custody concern, so they need no port of their own (see IdentityPort.deriveSharedSecret's own doc comment).
 *
 * A fresh random IV is generated for every AES-256-GCM operation here and prepended to the output -- never a fixed or derived IV -- since a wrapping key derived once per (room, key-epoch) may legitimately wrap more than once (e.g. a resent room.rekey), and reusing an AES-GCM IV under the same key is catastrophic (it discloses the authentication key and lets an attacker forge subsequent messages).
 */

const BITS_PER_BYTE = 8;
const AES_KEY_BYTE_LENGTH = 32; // AES-256
const AES_KEY_BIT_LENGTH = AES_KEY_BYTE_LENGTH * BITS_PER_BYTE;
const GCM_IV_BYTE_LENGTH = 12; // 96-bit, the size AES-GCM is specified and optimised for
const UINT32_BYTE_LENGTH = 4; // the room-path length prefix in hkdfInfo's own encoding
const UINT64_BYTE_LENGTH = 8; // the key-epoch field in hkdfInfo's own encoding

const HKDF_INFO_PREFIX = new TextEncoder().encode("wire-mesh/room-rekey/v1\0");

/** Generates a fresh, random 256-bit room content-encryption key (the thing room.rekey wraps and distributes, and that encryptNoticeContent/decryptNoticeContent use directly). */
export function generateContentKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(AES_KEY_BYTE_LENGTH));
}

/**
 * Binds HKDF's own `info` parameter to exactly the (room, key-epoch) pair a wrapping key is for, so a wrapping key derived for one room or one epoch can never successfully unwrap ciphertext produced under another -- domain separation from the derivation itself, not merely a convention callers must remember to check. Length-prefixing the room path (rather than a bare separator byte) keeps the encoding unambiguous regardless of what characters a room path itself may contain.
 */
function hkdfInfo(
  context: Readonly<{ room: string; keyEpoch: number }>,
): Uint8Array {
  const roomBytes = new TextEncoder().encode(context.room);
  const roomLength = new Uint8Array(UINT32_BYTE_LENGTH);
  new DataView(roomLength.buffer).setUint32(0, roomBytes.length, false);
  const keyEpoch = new Uint8Array(UINT64_BYTE_LENGTH);
  new DataView(keyEpoch.buffer).setBigUint64(
    0,
    BigInt(context.keyEpoch),
    false,
  );

  const info = new Uint8Array(
    HKDF_INFO_PREFIX.length +
      roomLength.length +
      roomBytes.length +
      keyEpoch.length,
  );
  let offset = 0;
  info.set(HKDF_INFO_PREFIX, offset);
  offset += HKDF_INFO_PREFIX.length;
  info.set(roomLength, offset);
  offset += roomLength.length;
  info.set(roomBytes, offset);
  offset += roomBytes.length;
  info.set(keyEpoch, offset);
  return info;
}

/**
 * Derives an AES-256-GCM wrapping key from a raw ECDH shared secret (IdentityPort.deriveSharedSecret's own output) via HKDF-SHA256, with `info` binding the result to exactly one (room, key-epoch) pair -- see hkdfInfo. No explicit salt: static-static ECDH already produces a high-entropy, uniformly-distributed shared secret, so an empty salt is the standard, RFC 5869-sanctioned choice here rather than a corner cut (a salt matters most when the input key material's own entropy is questionable, which a P-256 ECDH output is not).
 */
export async function deriveWrappingKey(
  sharedSecret: Uint8Array,
  context: Readonly<{ room: string; keyEpoch: number }>,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(sharedSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: Uint8Array.from(new Uint8Array(0)),
      info: Uint8Array.from(hkdfInfo(context)),
    },
    ikm,
    { name: "AES-GCM", length: AES_KEY_BIT_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTE_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      Uint8Array.from(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

async function aesGcmDecrypt(
  key: CryptoKey,
  ivAndCiphertext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (ivAndCiphertext.length < GCM_IV_BYTE_LENGTH) {
    throw new Error("ciphertext shorter than the AES-GCM IV it must carry");
  }
  const iv = ivAndCiphertext.slice(0, GCM_IV_BYTE_LENGTH);
  const ciphertext = ivAndCiphertext.slice(GCM_IV_BYTE_LENGTH);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext),
  );
}

/** Wraps a room content-encryption key for delivery in room.rekey's own `wrapped-key` field. */
export async function wrapContentKey(
  wrappingKey: CryptoKey,
  contentKey: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return aesGcmEncrypt(wrappingKey, contentKey);
}

/** Unwraps a room.rekey `wrapped-key` entry back into the room content-encryption key it carries. Rejects (never returns a garbage key) if the wrapping key or ciphertext don't match -- AES-GCM's own authentication tag catches both a wrong key and any tampering. */
export async function unwrapContentKey(
  wrappingKey: CryptoKey,
  wrapped: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return aesGcmDecrypt(wrappingKey, wrapped);
}

async function importContentKey(contentKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(contentKey),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts a room-notice's own `content` under the room's current content-encryption key -- encrypt-then-sign, layered underneath room-notice's existing cose-sign1 envelope (see room.cddl's key-epoch obligation), never a replacement for it. */
export async function encryptNoticeContent(
  contentKey: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return aesGcmEncrypt(await importContentKey(contentKey), plaintext);
}

/** Decrypts a room-notice's own `content`, given the content-encryption key for the epoch its key-epoch field names. Rejects on a wrong key or tampered ciphertext, same as unwrapContentKey. */
export async function decryptNoticeContent(
  contentKey: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return aesGcmDecrypt(await importContentKey(contentKey), ciphertext);
}

/** The literal content-type suffix marking a room-notice's content as AES-256-GCM-encrypted under a room.rekey epoch's content key (room.cddl's own key-epoch obligation comment) -- the same suffix convention MIME structured syntaxes like `application/jose+json` already use, so a reader without the key still learns the notice's true underlying kind. */
export const ENCRYPTED_CONTENT_TYPE_SUFFIX = "+aes256gcm";

/** The notice's own TRUE content-type, with the encryption suffix appended -- never a separate generic sentinel, so the true type stays visible without decrypting anything. Idempotent: an already-suffixed type is returned unchanged. */
export function encryptedContentType(plaintextContentType_: string): string {
  return isEncryptedContentType(plaintextContentType_)
    ? plaintextContentType_
    : `${plaintextContentType_}${ENCRYPTED_CONTENT_TYPE_SUFFIX}`;
}

/** Strips the encryption suffix back off, recovering the plaintext content-type the sender originally had. A content-type carrying no suffix is returned unchanged. */
export function plaintextContentType(encryptedContentType_: string): string {
  return isEncryptedContentType(encryptedContentType_)
    ? encryptedContentType_.slice(
        0,
        encryptedContentType_.length - ENCRYPTED_CONTENT_TYPE_SUFFIX.length,
      )
    : encryptedContentType_;
}

/** Whether a content-type names encrypted content (and therefore that the notice carrying it MUST also name its key-epoch -- room.cddl obligation 7). */
export function isEncryptedContentType(contentType: string): boolean {
  return contentType.endsWith(ENCRYPTED_CONTENT_TYPE_SUFFIX);
}
