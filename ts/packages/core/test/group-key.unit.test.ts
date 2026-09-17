import { describe, expect, it } from "vitest";
import {
  encryptedContentType,
  isEncryptedContentType,
  plaintextContentType,
  decryptNoticeContent,
  deriveWrappingKey,
  encryptNoticeContent,
  generateContentKey,
  unwrapContentKey,
  wrapContentKey,
} from "../src/domain/group-key.js";

const DEVICE_ID_HEX_LENGTH = 32; // 64 hex chars = 32-byte device-id, hex-encoded (room-path's own owner-hex component)
const SHARED_SECRET_BYTE_LENGTH = 32; // a P-256 ECDH shared secret's own byte length, standing in for a real one in these tests
const CONTENT_KEY_BYTE_LENGTH = 32; // AES-256
const LOW_BYTE_MASK = 0xff;

const ROOM_PATH = `${"aa".repeat(DEVICE_ID_HEX_LENGTH)}/general`;

describe("generateContentKey", () => {
  it("generates a fresh 32-byte key each call", () => {
    const a = generateContentKey();
    const b = generateContentKey();

    expect(a).toHaveLength(CONTENT_KEY_BYTE_LENGTH);
    expect(a).not.toEqual(b);
  });
});

describe("wrapContentKey / unwrapContentKey", () => {
  it("round-trips a content key through a derived wrapping key", async () => {
    const sharedSecret = crypto.getRandomValues(
      new Uint8Array(SHARED_SECRET_BYTE_LENGTH),
    );
    const wrappingKey = await deriveWrappingKey(sharedSecret, {
      room: ROOM_PATH,
      keyEpoch: 1,
    });
    const contentKey = generateContentKey();

    const wrapped = await wrapContentKey(wrappingKey, contentKey);
    const unwrapped = await unwrapContentKey(wrappingKey, wrapped);

    expect(unwrapped).toEqual(contentKey);
  });

  it("produces different wrapped bytes each call -- the IV is fresh, never reused", async () => {
    const sharedSecret = crypto.getRandomValues(
      new Uint8Array(SHARED_SECRET_BYTE_LENGTH),
    );
    const wrappingKey = await deriveWrappingKey(sharedSecret, {
      room: ROOM_PATH,
      keyEpoch: 1,
    });
    const contentKey = generateContentKey();

    const first = await wrapContentKey(wrappingKey, contentKey);
    const second = await wrapContentKey(wrappingKey, contentKey);

    expect(first).not.toEqual(second);
  });

  it("fails to unwrap under a wrapping key derived for a different key-epoch -- HKDF info binds the wrap to its own epoch", async () => {
    const sharedSecret = crypto.getRandomValues(
      new Uint8Array(SHARED_SECRET_BYTE_LENGTH),
    );
    const epoch1 = await deriveWrappingKey(sharedSecret, {
      room: ROOM_PATH,
      keyEpoch: 1,
    });
    const epoch2 = await deriveWrappingKey(sharedSecret, {
      room: ROOM_PATH,
      keyEpoch: 2,
    });
    const contentKey = generateContentKey();
    const wrapped = await wrapContentKey(epoch1, contentKey);

    await expect(unwrapContentKey(epoch2, wrapped)).rejects.toThrow();
  });

  it("fails to unwrap under a wrapping key derived for a different room -- HKDF info binds the wrap to its own room", async () => {
    const sharedSecret = crypto.getRandomValues(
      new Uint8Array(SHARED_SECRET_BYTE_LENGTH),
    );
    const roomA = await deriveWrappingKey(sharedSecret, {
      room: ROOM_PATH,
      keyEpoch: 1,
    });
    const roomB = await deriveWrappingKey(sharedSecret, {
      room: `${"bb".repeat(DEVICE_ID_HEX_LENGTH)}/general`,
      keyEpoch: 1,
    });
    const contentKey = generateContentKey();
    const wrapped = await wrapContentKey(roomA, contentKey);

    await expect(unwrapContentKey(roomB, wrapped)).rejects.toThrow();
  });

  it("two parties deriving from the same ECDH shared secret and context produce interoperable wrapping keys", async () => {
    // Static-static ECDH is symmetric (A.deriveSharedSecret(B) === B.deriveSharedSecret(A)), so both sides deriving independently from the identical shared-secret bytes and the identical context must reach byte-identical wrapping keys -- this is what actually makes room.rekey work without a separate key-exchange round trip.
    const sharedSecret = crypto.getRandomValues(
      new Uint8Array(SHARED_SECRET_BYTE_LENGTH),
    );
    const senderWrappingKey = await deriveWrappingKey(sharedSecret, {
      room: ROOM_PATH,
      keyEpoch: 3,
    });
    const recipientWrappingKey = await deriveWrappingKey(sharedSecret, {
      room: ROOM_PATH,
      keyEpoch: 3,
    });
    const contentKey = generateContentKey();

    const wrapped = await wrapContentKey(senderWrappingKey, contentKey);
    const unwrapped = await unwrapContentKey(recipientWrappingKey, wrapped);

    expect(unwrapped).toEqual(contentKey);
  });
});

describe("encryptNoticeContent / decryptNoticeContent", () => {
  it("round-trips notice content under a content key", async () => {
    const contentKey = generateContentKey();
    const plaintext = new TextEncoder().encode("see you at the usual spot");

    const ciphertext = await encryptNoticeContent(contentKey, plaintext);
    const decrypted = await decryptNoticeContent(contentKey, ciphertext);

    expect(decrypted).toEqual(plaintext);
  });

  it("produces different ciphertext bytes each call -- the IV is fresh, never reused", async () => {
    const contentKey = generateContentKey();
    const plaintext = new TextEncoder().encode("see you at the usual spot");

    const first = await encryptNoticeContent(contentKey, plaintext);
    const second = await encryptNoticeContent(contentKey, plaintext);

    expect(first).not.toEqual(second);
  });

  it("fails to decrypt tampered ciphertext -- AES-GCM's own authentication tag catches it", async () => {
    const contentKey = generateContentKey();
    const plaintext = new TextEncoder().encode("see you at the usual spot");
    const ciphertext = await encryptNoticeContent(contentKey, plaintext);
    const tampered = Uint8Array.from(ciphertext);
    tampered[tampered.length - 1] =
      (tampered[tampered.length - 1] ?? 0) ^ LOW_BYTE_MASK;

    await expect(decryptNoticeContent(contentKey, tampered)).rejects.toThrow();
  });

  it("fails to decrypt under the wrong content key", async () => {
    const contentKey = generateContentKey();
    const wrongKey = generateContentKey();
    const plaintext = new TextEncoder().encode("see you at the usual spot");
    const ciphertext = await encryptNoticeContent(contentKey, plaintext);

    await expect(decryptNoticeContent(wrongKey, ciphertext)).rejects.toThrow();
  });
});

describe("encrypted content-type suffix", () => {
  it("appends the suffix to a plaintext content-type", () => {
    expect(encryptedContentType("text/plain")).toBe("text/plain+aes256gcm");
  });

  it("is idempotent -- an already-encrypted content-type is returned unchanged, not double-suffixed", () => {
    expect(encryptedContentType("text/plain+aes256gcm")).toBe(
      "text/plain+aes256gcm",
    );
  });

  it("round-trips: stripping recovers the original plaintext content-type", () => {
    expect(plaintextContentType("text/plain+aes256gcm")).toBe("text/plain");
  });

  it("strips nothing from a plaintext content-type", () => {
    expect(plaintextContentType("text/plain")).toBe("text/plain");
  });

  it("identifies an encrypted content-type without stripping", () => {
    expect(isEncryptedContentType("text/plain+aes256gcm")).toBe(true);
    expect(isEncryptedContentType("text/plain")).toBe(false);
  });
});
