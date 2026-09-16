import { encryptedContentType } from "../src/domain/group-key.js";
import { describe, expect, it } from "vitest";
import { createRoomNotice, verifyRoomNotice } from "../src/domain/room.js";
import { createRevocationView } from "../src/domain/revocation-view.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import { ownerNamedRoomPath } from "../src/domain/room-path.js";
import { mintCapabilityToken } from "../src/domain/tokens.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { CapabilityToken } from "../src/generated/protocol.js";
import {
  HOUR_MS,
  fixedClock,
  generateEs256Identity,
  nextTokenId,
} from "./tokens-fixtures.js";
import { nextNoticeId } from "./room-notice-fixtures.js";

const NOW_MS = 1_893_456_000_000;
const EXPIRES_MS = NOW_MS + HOUR_MS;
const VALID_UNTIL_MS = NOW_MS + HOUR_MS;
const KEY_EPOCH = 1;

async function mintRoomMemberToken(
  issuer: IdentityPort,
  bearer: IdentityPort,
  roomPath: string,
): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock: fixedClock(NOW_MS),
    tokenId: nextTokenId(),
    bearer: bearer.deviceId,
    capability: "room:member",
    scope: { kind: "room", path: roomPath },
    expires: EXPIRES_MS,
    delegationsRemaining: 0,
  });
  if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);
  return verdict.token;
}

describe("createRoomNotice", () => {
  it("mints a notice that verifyRoomNotice accepts", async () => {
    const owner = await generateEs256Identity();
    const poster = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, poster, roomPath);

    const notice = await createRoomNotice({
      identity: poster,
      clock: fixedClock(NOW_MS),
      room: roomPath,
      token,
      noticeId: nextNoticeId(),
      contentType: "text/plain",
      content: new TextEncoder().encode("hello"),
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });

    expect(verdict.ok).toBe(true);
  });

  it("stamps posted-at from the injected clock, not a caller-supplied value", async () => {
    const owner = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, owner, roomPath);

    const notice = await createRoomNotice({
      identity: owner,
      clock: fixedClock(NOW_MS),
      room: roomPath,
      token,
      noticeId: nextNoticeId(),
      contentType: "text/plain",
      content: new TextEncoder().encode("hi"),
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });
    if (!verdict.ok) throw new Error(`unexpected: ${verdict.reason}`);
    expect(verdict.claims["posted-at"]).toBe(NOW_MS);
  });

  it("embeds the poster's own device-id and identity key, self-certifying", async () => {
    const owner = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, owner, roomPath);

    const notice = await createRoomNotice({
      identity: owner,
      clock: fixedClock(NOW_MS),
      room: roomPath,
      token,
      noticeId: nextNoticeId(),
      contentType: "text/plain",
      content: new TextEncoder().encode("hi"),
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });
    if (!verdict.ok) throw new Error(`unexpected: ${verdict.reason}`);
    expect(verdict.claims.poster).toEqual(owner.deviceId);
  });

  it("carries refs and valid-until through when given", async () => {
    const owner = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, owner, roomPath);
    const priorNoticeId = nextNoticeId();

    const notice = await createRoomNotice({
      identity: owner,
      clock: fixedClock(NOW_MS),
      room: roomPath,
      token,
      noticeId: nextNoticeId(),
      content: new TextEncoder().encode("hi"),
      refs: [{ id: priorNoticeId, relation: "reply" }],
      validUntil: VALID_UNTIL_MS,
      // An encrypted notice: content-type carries the +aes256gcm suffix (room.cddl
      // obligation 7), so key-epoch must be present alongside it -- the pairing
      // verifyRoomNotice's key_epoch_mismatch check requires.
      contentType: encryptedContentType("text/plain"),
      keyEpoch: KEY_EPOCH,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });
    if (!verdict.ok) throw new Error(`unexpected: ${verdict.reason}`);
    expect(verdict.claims.refs).toEqual([
      { id: priorNoticeId, relation: "reply" },
    ]);
    expect(verdict.claims["valid-until"]).toBe(VALID_UNTIL_MS);
    expect(verdict.claims["key-epoch"]).toBe(KEY_EPOCH);
  });

  it("omits refs and valid-until entirely when not given, rather than stray undefined keys", async () => {
    const owner = await generateEs256Identity();
    const roomPath = ownerNamedRoomPath(
      deviceIdToHex(owner.deviceId),
      "general",
    );
    const token = await mintRoomMemberToken(owner, owner, roomPath);

    const notice = await createRoomNotice({
      identity: owner,
      clock: fixedClock(NOW_MS),
      room: roomPath,
      token,
      noticeId: nextNoticeId(),
      contentType: "text/plain",
      content: new TextEncoder().encode("hi"),
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: createRevocationView(),
    });
    if (!verdict.ok) throw new Error(`unexpected: ${verdict.reason}`);
    expect("refs" in verdict.claims).toBe(false);
    expect("valid-until" in verdict.claims).toBe(false);
    expect("key-epoch" in verdict.claims).toBe(false);
  });
});
