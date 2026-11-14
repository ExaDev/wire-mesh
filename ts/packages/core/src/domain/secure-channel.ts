/**
 * The end-to-end channel two devices open between themselves inside a relay pairing (spec/secure-channel.cddl). A relay only forwards the bytes of a `relay-data` frame, and without this it could read them, alter them, and say who sent them. Here the two devices authenticate each other's identity keys over a fresh ECDH exchange, derive one AES-256-GCM key per direction, and seal every frame they exchange so the relay sees ciphertext and every receiver learns the sender's identity from the handshake and nothing a relay asserts.
 *
 * Pure crypto and framing, with no connection or session in it: beginHandshake and verifyHello and establishChannel are the three steps of the handshake, and a SecureChannel then seals and opens frames. mesh-session.ts owns when to do each, and where the results travel.
 */

import { messageFromFrame, tryDecodeFrame } from "../adapters/frame-codec.js";
import type {
  DeviceId,
  Frame,
  IdentityKey,
  SecureDataFrame,
  SecureHelloFrame,
} from "../generated/protocol.js";
import { IdentityKeyError, type IdentityPort } from "../ports/identity.js";
import { ChannelExhaustedError } from "./channel-exhausted-error.js";
import { bytesEqual } from "./token-scope.js";

const NONCE_BYTE_LENGTH = 16;
const AES_KEY_BIT_LENGTH = 256;
const ECDH_SECRET_BIT_LENGTH = 256;
const GCM_IV_BYTE_LENGTH = 12;
/** The counter fills the last eight bytes of the IV; the four before it stay zero. */
const IV_COUNTER_OFFSET = 4;
const COUNTER_BYTE_LENGTH = 8;

const encoder = new TextEncoder();
const HELLO_CONTEXT = encoder.encode("wire-mesh/secure-hello/v1\0");
const CHANNEL_CONTEXT = encoder.encode("wire-mesh/secure-channel/v1\0");
const DATA_CONTEXT = encoder.encode("wire-mesh/secure-data/v1\0");
const LABEL_LOW_TO_HIGH = encoder.encode("lo-to-hi");
const LABEL_HIGH_TO_LOW = encoder.encode("hi-to-lo");

const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" } as const;

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/** Bytewise order of two device-ids: negative when a sorts first. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }

  return a.length - b.length;
}

function counterBytes(counter: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(COUNTER_BYTE_LENGTH);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(counter), false);

  return bytes;
}

/** Exactly what a hello's signature covers: see spec/secure-channel.cddl. */
function helloSigningInput(
  ephemeralKey: Uint8Array,
  nonce: Uint8Array,
  sender: DeviceId,
  recipient: DeviceId,
): Uint8Array<ArrayBuffer> {
  return concat(HELLO_CONTEXT, ephemeralKey, nonce, sender, recipient);
}

/** One side's half of a handshake between sending its hello and receiving the peer's: the hello as sent and the ephemeral private key it announced. */
export interface PendingHandshake {
  readonly peer: DeviceId;
  readonly hello: SecureHelloFrame;
  readonly privateKey: CryptoKey;
}

/** The device on the other end of a channel, as its own hello proved it to be. */
export interface SecureChannelPeer {
  readonly deviceId: DeviceId;
  readonly identityKey: IdentityKey;
}

/** Generates this side's ephemeral key pair and nonce and signs a hello for peer. */
export async function beginHandshake(
  identity: Readonly<IdentityPort>,
  peer: DeviceId,
): Promise<PendingHandshake> {
  const pair = await crypto.subtle.generateKey(ECDH_PARAMS, false, [
    "deriveBits",
  ]);
  const ephemeralKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTE_LENGTH));
  const signature = await identity.sign(
    helloSigningInput(ephemeralKey, nonce, identity.deviceId, peer),
  );

  return {
    peer,
    privateKey: pair.privateKey,
    hello: {
      type: "secure-hello",
      "ephemeral-key": ephemeralKey,
      nonce,
      "identity-key": identity.identityKey,
      "to-device": peer,
      signature,
    },
  };
}

/**
 * Why a hello was refused, in the order the checks run: the hello is addressed to another device (`wrong_recipient`), the identity-key's algorithm is not supported (`unsupported_identity_alg`), the identity-key is not a usable key for its algorithm (`invalid_identity_key`, for instance the wrong size or not a curve point), or the signature does not verify (`bad_signature`). The sender's device-id is derived from the identity-key, so there is no check that could refuse a hello for not matching one.
 */
export type HelloRefusal =
  | "wrong_recipient"
  | "unsupported_identity_alg"
  | "invalid_identity_key"
  | "bad_signature";

export type HelloVerdict =
  | { readonly ok: true; readonly peer: SecureChannelPeer }
  | { readonly ok: false; readonly reason: HelloRefusal };

/**
 * Checks a received hello: it must be addressed to this device, its identity key must be a usable key, and its signature must verify under that key over the input spec/secure-channel.cddl defines. A hostile hello gets a verdict. An error from the identity port that is not an IdentityKeyError is a failure of the port, not a verdict about the peer, and propagates.
 */
export async function verifyHello(
  identity: Readonly<IdentityPort>,
  hello: Readonly<SecureHelloFrame>,
): Promise<HelloVerdict> {
  const key = hello["identity-key"];
  // Hashing the key cannot fail for a sound port. A port that fails here is failing itself, not the peer: the error propagates, and the caller (relay-channels.ts) drops the hello and reports it locally.
  const sender = await identity.deriveDeviceId(key["public-key"]);
  if (!bytesEqual(hello["to-device"], identity.deviceId)) {
    return { ok: false, reason: "wrong_recipient" };
  }
  try {
    const valid = await identity.verify(
      key,
      helloSigningInput(
        hello["ephemeral-key"],
        hello.nonce,
        sender,
        identity.deviceId,
      ),
      hello.signature,
    );

    return valid
      ? { ok: true, peer: { deviceId: sender, identityKey: key } }
      : { ok: false, reason: "bad_signature" };
  } catch (error) {
    if (!(error instanceof IdentityKeyError)) {
      throw error;
    }

    return {
      ok: false,
      reason:
        error.fault === "unsupported_alg"
          ? "unsupported_identity_alg"
          : "invalid_identity_key",
    };
  }
}

/** One end of an established channel. */
export interface SecureChannel {
  readonly peer: SecureChannelPeer;
  /** Seals one frame for the peer, taking the next counter. Calls are ordered: the frame sealed first carries the lower counter. */
  seal: (frame: Frame) => Promise<SecureDataFrame>;
  /** Opens a frame from the peer. Undefined when it does not open, is replayed or reordered, or does not decode as a frame; nothing else is ever returned. */
  open: (data: Readonly<SecureDataFrame>) => Promise<Frame | undefined>;
  /** What `open` does, with the reason a frame was refused: `open` is exactly this with the reason dropped. */
  openOutcome: (data: Readonly<SecureDataFrame>) => Promise<OpenOutcome>;
}

/**
 * Why a sealed frame did not open, in the order the checks run: its counter is not above every counter already accepted (`replayed`, checked before decrypting, so a frame that is both replayed and altered is `replayed`), it does not authenticate under the channel's key and its own counter, IV and associated data (`unauthentic`), or it authenticates but its plaintext is not one frame (`undecodable`, the only refusal that consumes its counter).
 */
export type OpenRefusal = "replayed" | "unauthentic" | "undecodable";

export type OpenOutcome =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: false; readonly reason: OpenRefusal };

/** The largest counter a channel uses: the counter is an unsigned 64-bit integer on the wire, and this implementation holds it as a JavaScript number, exact up to this value. A frame above it is refused at decoding, never truncated, and sealing refuses to go past it, never wraps. */
export const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

/** Throws a RangeError unless `counter` is a counter a channel can start from: a non-negative safe integer. */
export function assertFirstSendCounter(counter: number): void {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError(
      "firstSendCounter must be a non-negative safe integer",
    );
  }
}

/**
 * Takes the next send counter from `next`, the counter the next seal would use: returns it with the counter that follows. Throws once `next` is past MAX_COUNTER, since a counter that cannot be held exactly would repeat an IV under the same key.
 */
export function claimSendCounter(next: number): {
  readonly counter: number;
  readonly next: number;
} {
  if (next > MAX_COUNTER) {
    throw new ChannelExhaustedError();
  }

  return { counter: next, next: next + 1 };
}

function ivFor(counter: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(GCM_IV_BYTE_LENGTH);
  iv.set(counterBytes(counter), IV_COUNTER_OFFSET);

  return iv;
}

function associatedData(
  sender: DeviceId,
  recipient: DeviceId,
  counter: number,
): Uint8Array<ArrayBuffer> {
  return concat(DATA_CONTEXT, sender, recipient, counterBytes(counter));
}

async function deriveDirectionKey({
  secret,
  salt,
  low,
  high,
  label,
}: Readonly<{
  secret: Uint8Array;
  salt: Uint8Array;
  low: DeviceId;
  high: DeviceId;
  label: Uint8Array;
}>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: Uint8Array.from(salt),
      info: concat(CHANNEL_CONTEXT, low, high, label),
    },
    material,
    { name: "AES-GCM", length: AES_KEY_BIT_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Completes a handshake once the peer's hello has verified: derives the two directional keys from the ECDH result of the ephemeral keys and returns the channel. Returns undefined when the peer's ephemeral key is not a valid P-256 point, which only a hostile or broken peer sends.
 *
 * `peer` is the device verifyHello authenticated for `remote`, and `pending` is this side's own half, whether the handshake was begun here or in answer to that hello.
 */
export async function establishChannel(
  identity: Readonly<IdentityPort>,
  pending: Readonly<PendingHandshake>,
  remote: Readonly<SecureHelloFrame>,
  peer: Readonly<SecureChannelPeer>,
): Promise<SecureChannel | undefined> {
  return establishChannelFrom(identity, { pending, remote, peer });
}

/**
 * establishChannel with its inputs in one object, and the one extra that tests need: where this end's send counter starts. This module is not a published entry (it is in tsdown.config.ts's INTERNAL_MODULES) and the session never passes `firstSendCounter`, so every real channel starts at 0; a test passes a counter near MAX_COUNTER to reach the bound without sealing 2^53 frames.
 */
export async function establishChannelFrom(
  identity: Readonly<IdentityPort>,
  {
    pending,
    remote,
    peer,
    firstSendCounter = 0,
  }: Readonly<{
    pending: Readonly<PendingHandshake>;
    remote: Readonly<SecureHelloFrame>;
    peer: Readonly<SecureChannelPeer>;
    firstSendCounter?: number;
  }>,
): Promise<SecureChannel | undefined> {
  assertFirstSendCounter(firstSendCounter);
  let secret: Uint8Array;
  try {
    const remoteKey = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(remote["ephemeral-key"]),
      ECDH_PARAMS,
      false,
      [],
    );
    secret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: remoteKey },
        pending.privateKey,
        ECDH_SECRET_BIT_LENGTH,
      ),
    );
  } catch {
    return undefined;
  }

  const localIsLow = compareBytes(identity.deviceId, peer.deviceId) < 0;
  const low = localIsLow ? identity.deviceId : peer.deviceId;
  const high = localIsLow ? peer.deviceId : identity.deviceId;
  const lowNonce = localIsLow ? pending.hello.nonce : remote.nonce;
  const highNonce = localIsLow ? remote.nonce : pending.hello.nonce;
  const salt = concat(lowNonce, highNonce);
  const lowToHigh = await deriveDirectionKey({
    secret,
    salt,
    low,
    high,
    label: LABEL_LOW_TO_HIGH,
  });
  const highToLow = await deriveDirectionKey({
    secret,
    salt,
    low,
    high,
    label: LABEL_HIGH_TO_LOW,
  });
  const sendKey = localIsLow ? lowToHigh : highToLow;
  const receiveKey = localIsLow ? highToLow : lowToHigh;

  let nextSendCounter = firstSendCounter;
  let highestReceived = -1;
  let sealing: Promise<unknown> = Promise.resolve();
  let opening: Promise<unknown> = Promise.resolve();

  async function sealAt(
    frame: Frame,
    counter: number,
  ): Promise<SecureDataFrame> {
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: ivFor(counter),
          additionalData: associatedData(
            identity.deviceId,
            peer.deviceId,
            counter,
          ),
        },
        sendKey,
        messageFromFrame(frame),
      ),
    );

    return { type: "secure-data", counter, ciphertext };
  }

  async function openOne(
    data: Readonly<SecureDataFrame>,
  ): Promise<OpenOutcome> {
    if (data.counter <= highestReceived) {
      return { ok: false, reason: "replayed" };
    }
    let plaintext: Uint8Array;
    try {
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: ivFor(data.counter),
            additionalData: associatedData(
              peer.deviceId,
              identity.deviceId,
              data.counter,
            ),
          },
          receiveKey,
          Uint8Array.from(data.ciphertext),
        ),
      );
    } catch {
      return { ok: false, reason: "unauthentic" };
    }
    // Advanced only after the frame authenticated, so a forged counter cannot lock out the real ones.
    highestReceived = Math.max(highestReceived, data.counter);

    const frame = tryDecodeFrame(plaintext);

    return frame === null
      ? { ok: false, reason: "undecodable" }
      : { ok: true, frame };
  }

  const openOutcome = async (
    data: Readonly<SecureDataFrame>,
  ): Promise<OpenOutcome> => {
    // Chained for the same reason as sealing: two frames opening at once must not both pass the counter check before either has advanced it.
    const opened = opening.then(async () => openOne(data));
    opening = opened.catch(() => undefined);

    return opened;
  };

  return {
    peer,
    seal: async (frame) => {
      const claimed = claimSendCounter(nextSendCounter);
      const counter = claimed.counter;
      nextSendCounter = claimed.next;
      // Sealing is chained so frames leave in counter order even if the runtime finishes two encryptions out of order: the receiver refuses a counter it has already passed.
      const sealed = sealing.then(async () => sealAt(frame, counter));
      sealing = sealed.catch(() => undefined);

      return sealed;
    },
    open: async (data) => {
      const outcome = await openOutcome(data);

      return outcome.ok ? outcome.frame : undefined;
    },
    openOutcome,
  };
}
