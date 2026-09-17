import { describe, expect, it } from "vitest";
import { compareRoomNotices, verifyRoomNotice } from "../src/domain/room.js";
import { createRevocationView } from "../src/domain/revocation-view.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import { dmRoomPath, ownerNamedRoomPath } from "../src/domain/room-path.js";
import {
  mintCapabilityToken,
  mintRevocationEntry,
} from "../src/domain/tokens.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type {
  CapabilityToken,
  RoomNoticeClaims,
} from "../src/generated/protocol.js";
import {
  DEVICE_ID_BYTE_LENGTH,
  HOUR_MS,
  P256_SIGNATURE_BYTE_LENGTH,
  fixedClock,
  generateEs256Identity,
  nextTokenId,
} from "./tokens-fixtures.js";
import { signRoomNotice } from "./room-notice-fixtures.js";

const NOW_MS = 1_893_456_000_000;
const EXPIRES_MS = NOW_MS + HOUR_MS;
const INVALID_CBOR_BYTE = 0xff; // not a valid CBOR major-type/length prefix combination -- decode() throws on it
const FAR_FUTURE_HOURS = 1_000;
const LONG_AFTER_POSTING_HOURS = 10;

async function mintRoomMemberToken(
  issuer: IdentityPort,
  bearer: IdentityPort,
  roomPath: string,
  expires: number = EXPIRES_MS,
): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock: fixedClock(NOW_MS),
    tokenId: nextTokenId(),
    bearer: bearer.deviceId,
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);
  return verdict.token;
}

describe("verifyRoomNotice", () => {
  it("accepts a well-formed notice posted in a named room", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict.ok).toBe(true);
  });

  it("accepts a well-formed notice posted in a DM room, verified by one of the two participants", async () => {
    const me = await generateEs256Identity();
    const them = await generateEs256Identity();
    const roomPath = dmRoomPath(
      deviceIdToHex(me.deviceId),
      deviceIdToHex(them.deviceId),
    );
    const token = await mintRoomMemberToken(me, them, roomPath);
    const notice = await signRoomNotice(them, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: me,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict.ok).toBe(true);
  });

  it("rejects a notice whose envelope payload is absent", async () => {
    const owner = await generateEs256Identity();

    const verdict = await verifyRoomNotice(
      [new Uint8Array(), {}, null, new Uint8Array()],
      {
        identity: owner,
        clock: fixedClock(NOW_MS),
        revocation: createRevocationView(),
      },
    );

    expect(verdict).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a notice whose payload does not decode as room-notice-claims", async () => {
    const owner = await generateEs256Identity();

    const verdict = await verifyRoomNotice(
      [
        new Uint8Array(),
        {},
        new Uint8Array([INVALID_CBOR_BYTE, INVALID_CBOR_BYTE]),
        new Uint8Array(),
      ],
      {
        identity: owner,
        clock: fixedClock(NOW_MS),
        revocation: createRevocationView(),
      },
    );

    expect(verdict).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a notice whose signature has been tampered with", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
    });
    const tampered = [
      notice[0],
      notice[1],
      notice[2],
      new Uint8Array(P256_SIGNATURE_BYTE_LENGTH),
    ] as typeof notice;

    const verdict = await verifyRoomNotice(tampered, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a notice whose poster field does not match its own poster-key", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const someoneElse = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      poster: someoneElse.deviceId,
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict).toEqual({ ok: false, reason: "wrong_poster" });
  });

  it("rejects a notice claiming a different room than the caller expected", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const otherRoomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "other",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedRoom: otherRoomPath,
    });

    expect(verdict).toEqual({ ok: false, reason: "wrong_room" });
  });

  it("accepts a notice matching the caller's expectedRoom", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
      expectedRoom: roomPath,
    });

    expect(verdict.ok).toBe(true);
  });

  it("rejects a notice whose embedded token bears a different device than the poster", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const impostor = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    // The embedded token bears `impostor`, but the notice's own signed poster field claims `poster`.
    const token = await mintRoomMemberToken(owner, impostor, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict).toEqual({ ok: false, reason: "bearer_mismatch" });
  });

  it("rejects a notice whose embedded token is scoped to a non-room capability", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const mintVerdict = await mintCapabilityToken({
      identity: owner,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: poster.deviceId,
      capability: "exec:pty",
      scope: { kind: "folder" },
      expires: EXPIRES_MS,
    });
    if (!mintVerdict.ok) throw new Error(`mint failed: ${mintVerdict.reason}`);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token: mintVerdict.token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict).toEqual({ ok: false, reason: "wrong_scope_kind" });
  });

  it("rejects a notice whose embedded token is scoped to a different room", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const actualRoomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const otherRoomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "other",
    );
    const token = await mintRoomMemberToken(owner, poster, otherRoomPath);
    const notice = await signRoomNotice(poster, {
      room: actualRoomPath,
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict).toEqual({ ok: false, reason: "wrong_scope_path" });
  });

  it("rejects a notice whose embedded token is rooted at neither the room's owner nor the verifier", async () => {
    const owner = await generateEs256Identity();
    const impostor = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    // Self-issued by an impostor, not the room's real owner -- the attack this obligation exists to catch.
    const token = await mintRoomMemberToken(impostor, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict).toEqual({ ok: false, reason: "wrong_chain_root" });
  });

  it("rejects a notice whose embedded token has expired", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(
      owner,
      poster,
      roomPath,
      NOW_MS + 1,
    );
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS + HOUR_MS),
      revocation: createRevocationView(),
    });

    expect(verdict).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a notice whose embedded token has been revoked", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const tokenId = nextTokenId();
    const mintVerdict = await mintCapabilityToken({
      identity: owner,
      clock: fixedClock(NOW_MS),
      tokenId,
      bearer: poster.deviceId,
      capability: "room:member",
      scope: { kind: "room", path: roomPath },
      expires: EXPIRES_MS,
      delegationsRemaining: 0,
    });
    if (!mintVerdict.ok) throw new Error(`mint failed: ${mintVerdict.reason}`);
    const revocation = createRevocationView();
    const entry = await mintRevocationEntry({
      identity: owner,
      tokenId,
      revokedAt: NOW_MS,
    });
    await revocation.record(entry, { identity: owner });
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token: mintVerdict.token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation,
    });

    expect(verdict).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects a notice whose own valid-until has already elapsed", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
      validUntil: NOW_MS + 1,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS + HOUR_MS),
      revocation: createRevocationView(),
    });

    expect(verdict).toEqual({ ok: false, reason: "content_expired" });
  });

  it("accepts a notice whose valid-until has not yet elapsed", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
      validUntil: NOW_MS + HOUR_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict.ok).toBe(true);
  });

  it("accepts a notice with no valid-until at all (unbounded), even long after posting", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const farFutureExpiry = NOW_MS + FAR_FUTURE_HOURS * HOUR_MS;
    const token = await mintRoomMemberToken(
      owner,
      poster,
      roomPath,
      farFutureExpiry,
    );
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS + LONG_AFTER_POSTING_HOURS * HOUR_MS),
      revocation: createRevocationView(),
    });

    expect(verdict.ok).toBe(true);
  });

  it("accepts an encrypted notice whose content-type and key-epoch agree", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
      contentType: "text/plain+aes256gcm",
      keyEpoch: 1,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict.ok).toBe(true);
  });

  it("rejects an encrypted content-type with no key-epoch -- the reader could not know which epoch to decrypt under", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
      contentType: "text/plain+aes256gcm",
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict).toEqual({ ok: false, reason: "key_epoch_mismatch" });
  });

  it("rejects a key-epoch on a plaintext content-type -- the epoch would name a key nothing was encrypted under", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);
    const notice = await signRoomNotice(poster, {
      room: roomPath,
      token,
      postedAt: NOW_MS,
      contentType: "text/plain",
      keyEpoch: 1,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict).toEqual({ ok: false, reason: "key_epoch_mismatch" });
  });
});

describe("compareRoomNotices", () => {
  const EARLIER_POSTED_AT = 100;
  const LATER_POSTED_AT = 200;
  const HIGH_TIEBREAK_BYTE = 9;

  function buf(bytes: ArrayLike<number>): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(bytes);
  }

  function claimsWith(
    postedAt: number,
    poster: Uint8Array<ArrayBuffer>,
    noticeId: Uint8Array<ArrayBuffer>,
  ): RoomNoticeClaims {
    return {
      room: "aa".repeat(DEVICE_ID_BYTE_LENGTH) + "/general",
      poster,
      "poster-key": { alg: -7, "public-key": buf([]) },
      token: [buf([]), {}, buf([]), buf([])],
      "notice-id": noticeId,
      "posted-at": postedAt,
      "content-type": "text/plain",
      content: buf([]),
    };
  }

  it("orders by posted-at first", () => {
    const p = buf([1]);
    const earlier = claimsWith(EARLIER_POSTED_AT, p, buf([1]));
    const later = claimsWith(LATER_POSTED_AT, p, buf([1]));

    expect(compareRoomNotices(earlier, later)).toBeLessThan(0);
    expect(compareRoomNotices(later, earlier)).toBeGreaterThan(0);
  });

  it("breaks a posted-at tie by poster, lowest first", () => {
    const a = claimsWith(
      EARLIER_POSTED_AT,
      buf([1]),
      buf([HIGH_TIEBREAK_BYTE]),
    );
    const b = claimsWith(EARLIER_POSTED_AT, buf([2]), buf([0]));

    expect(compareRoomNotices(a, b)).toBeLessThan(0);
  });

  it("breaks a posted-at and poster tie by notice-id, lowest first", () => {
    const p = buf([1]);
    const a = claimsWith(EARLIER_POSTED_AT, p, buf([1]));
    const b = claimsWith(EARLIER_POSTED_AT, p, buf([2]));

    expect(compareRoomNotices(a, b)).toBeLessThan(0);
    expect(compareRoomNotices(b, a)).toBeGreaterThan(0);
    expect(compareRoomNotices(a, a)).toBe(0);
  });
});
