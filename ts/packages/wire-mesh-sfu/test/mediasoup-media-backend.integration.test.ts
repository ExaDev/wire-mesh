// Exercises createMediasoupMediaBackend against a real mediasoup Worker/Router/WebRtcTransport (no mocks): proves the SDP<->RtpParameters bridge actually produces real Producers and Consumers a real router accepts, not just structurally plausible-looking data. Does not drive a real browser peer: no ICE/DTLS handshake ever completes, so this cannot prove media actually flows end to end (see this package's README for that explicit, honest scope boundary). What it does prove: a real offer, parsed and intersected against a real router's own codec capabilities, yields a real Producer; a second participant's recvonly slot gets filled by a real Consumer of the first participant's real Producer; the built answer SDP is well-formed and carries the real transport's own ICE/DTLS parameters; leave() actually closes resources and reports the right affected participant.

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseSdp } from "sdp-transform";
import {
  createMediasoupMediaBackend,
  type MediasoupMediaBackendOptions,
} from "../src/adapters/mediasoup-media-backend.js";
import type { SfuMediaBackend } from "../src/domain/media-backend.js";
import { CHROME_SHAPED_OFFER } from "./fixtures/chrome-offer.js";

const LOCALHOST: MediasoupMediaBackendOptions = { listenIp: "127.0.0.1" };

describe("createMediasoupMediaBackend, against a real mediasoup Worker", () => {
  let backend: SfuMediaBackend | undefined;

  afterEach(async () => {
    // mediasoup has no explicit "close the whole backend" method in this port (a real deployment runs one backend for the process's own lifetime), but leave()ing every participant this test created closes their transports and everything under them, so the underlying mediasoup Worker has nothing left running by the time the next test's own createMediasoupMediaBackend() call spins up a fresh one.
    await backend?.leave("participant-b");
    await backend?.leave("participant-a");
    backend = undefined;
  });

  it("produces real Producers from a send-capable offer and builds a well-formed, parseable answer", async () => {
    backend = await createMediasoupMediaBackend(LOCALHOST);
    const result = await backend.join("participant-b", CHROME_SHAPED_OFFER);

    expect(result.produced).toEqual(
      expect.arrayContaining([
        { mid: "0", kind: "audio" },
        { mid: "1", kind: "video" },
      ]),
    );
    // No one else has joined yet, so participant-b's own recvonly slot (mid 2) has nothing to consume.
    expect(result.consumed).toEqual([]);

    const parsedAnswer = parseSdp(result.answerSdp);
    expect(parsedAnswer.media.map((media) => String(media.mid))).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);
    const audioAnswer = parsedAnswer.media[0];
    expect(audioAnswer?.direction).toBe("inactive"); // produced-from mid: the SFU never sends media back on the same mid it received on
    expect(audioAnswer?.iceUfrag).toBeTruthy();
    expect(audioAnswer?.icePwd).toBeTruthy();
    expect(audioAnswer?.fingerprint?.type).toBeTruthy();
    expect(audioAnswer?.setup).toBe("active");
    const applicationAnswer = parsedAnswer.media[3];
    expect(applicationAnswer?.type).toBe("application");
    expect(applicationAnswer?.port).toBe(0);
  });

  it("fills a second participant's recvonly slot with the first participant's real video Producer via a real Consumer", async () => {
    backend = await createMediasoupMediaBackend(LOCALHOST);
    await backend.join("participant-b", CHROME_SHAPED_OFFER);
    const resultA = await backend.join("participant-a", CHROME_SHAPED_OFFER);

    expect(resultA.consumed).toEqual([
      { mid: "2", kind: "video", fromParticipantId: "participant-b" },
    ]);

    const parsedAnswer = parseSdp(resultA.answerSdp);
    const filledSlot = parsedAnswer.media[2];
    expect(filledSlot?.direction).toBe("sendonly");
    // mediasoup assigns the Consumer its own fresh payload type (and, for video, a companion RTX codec) rather than reusing the original Producer's offer-side payload type, a genuine, correct part of how mediasoup negotiates a Consumer, not a value this bridge chooses, so this only checks the codec name, not an exact payload type.
    expect(filledSlot?.rtp.map((entry) => entry.codec)).toEqual(
      expect.arrayContaining(["VP8"]),
    );
  });

  it("leave() closes the leaving participant's own resources and reports every other participant it was streaming to", async () => {
    backend = await createMediasoupMediaBackend(LOCALHOST);
    await backend.join("participant-b", CHROME_SHAPED_OFFER);
    await backend.join("participant-a", CHROME_SHAPED_OFFER);

    const affected = await backend.leave("participant-b");
    expect(affected).toEqual(["participant-a"]);

    // participant-b itself is gone: a second leave() is a no-op, not an error.
    await expect(backend.leave("participant-b")).resolves.toEqual([]);
  });
});
