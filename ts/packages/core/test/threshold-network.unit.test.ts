import { describe, expect, it } from "vitest";
import type { DeviceId } from "../src/generated/protocol.js";
import {
  THRESHOLD_GROUP_SCOPE,
  THRESHOLD_KEYGEN_VERB,
  THRESHOLD_RESHARE_VERB,
  THRESHOLD_SIGN_VERB,
  buildAbortCommand,
  buildCommitCommand,
  buildKeygenConfirmCommand,
  buildKeygenRound1Command,
  buildKeygenRound2Command,
  buildSignCommand,
  isThresholdAbort,
  isThresholdCommit,
  isThresholdKeygenConfirm,
  isThresholdKeygenRound1,
  isThresholdKeygenRound2,
  isThresholdSign,
  keygenCapabilityVerb,
} from "../src/domain/threshold-network.js";
import type { ThresholdSubject } from "../src/domain/threshold-subject.js";

const DEVICE_ID_LENGTH = 32;
const GROUP_DEVICE_BYTE = 9;
const DEADLINE_MS = 1_000;
const THRESHOLD = 2;
const COMMIT_SESSION_ID = 1n;
const SIGN_SESSION_ID = 2n;
const ABORT_SESSION_ID = 3n;
const FRESH_DKG_SESSION_ID = 4n;
const RESHARE_SESSION_ID = 5n;
const ROUND2_CONFIRM_SESSION_ID = 6n;
const GROUP_KEY_FILL_BYTE = 7;

function deviceId(byte: number): DeviceId {
  const bytes = new Uint8Array(DEVICE_ID_LENGTH);
  bytes[DEVICE_ID_LENGTH - 1] = byte;
  return bytes;
}

const subject: ThresholdSubject = {
  kind: "capability-token",
  protected: new Uint8Array([1]),
  payload: new Uint8Array([2]),
};

describe("threshold-network: command builders and type guards", () => {
  it("buildCommitCommand carries the group-scoped exadev.io/threshold:sign verb", () => {
    const command = buildCommitCommand(
      COMMIT_SESSION_ID,
      deviceId(GROUP_DEVICE_BYTE),
      subject,
      DEADLINE_MS,
    );
    expect(command.verb).toBe(THRESHOLD_SIGN_VERB);
    expect(isThresholdCommit(command.params)).toBe(true);
    if (!isThresholdCommit(command.params)) {
      throw new Error("expected threshold.commit params");
    }
    expect(command.params["session-id"]).toBe(Number(COMMIT_SESSION_ID));
    expect(command.params.deadline).toBe(DEADLINE_MS);
    expect(command.params.subject).toEqual(subject);
  });

  it("buildSignCommand round-trips its commitments", () => {
    const commitments = [
      {
        participant: deviceId(1),
        hiding: new Uint8Array([1]),
        binding: new Uint8Array([2]),
      },
    ];
    const command = buildSignCommand(SIGN_SESSION_ID, commitments);
    expect(isThresholdSign(command.params)).toBe(true);
    if (!isThresholdSign(command.params)) {
      throw new Error("expected threshold.sign params");
    }
    expect(command.params.commitments).toEqual(commitments);
  });

  it("buildAbortCommand omits reason when not given, includes it when given", () => {
    const withoutReason = buildAbortCommand(ABORT_SESSION_ID);
    if (!isThresholdAbort(withoutReason.params)) {
      throw new Error("expected threshold.abort params");
    }
    expect(withoutReason.params.reason).toBeUndefined();

    const withReason = buildAbortCommand(ABORT_SESSION_ID, "timed out");
    if (!isThresholdAbort(withReason.params)) {
      throw new Error("expected threshold.abort params");
    }
    expect(withReason.params.reason).toBe("timed out");
  });

  it("keygenCapabilityVerb picks :keygen for fresh DKG and :reshare for a reshare", () => {
    expect(keygenCapabilityVerb(false)).toBe(THRESHOLD_KEYGEN_VERB);
    expect(keygenCapabilityVerb(true)).toBe(THRESHOLD_RESHARE_VERB);
  });

  it("buildKeygenRound1Command carries the fresh-DKG shape with proof-of-knowledge, no existing-group-key", () => {
    const command = buildKeygenRound1Command(
      FRESH_DKG_SESSION_ID,
      THRESHOLD,
      [deviceId(1), deviceId(2)],
      [new Uint8Array([1])],
      { proofOfKnowledge: new Uint8Array([GROUP_DEVICE_BYTE]) },
    );
    expect(command.verb).toBe(THRESHOLD_KEYGEN_VERB);
    if (!isThresholdKeygenRound1(command.params)) {
      throw new Error("expected threshold.keygen-round1 params");
    }
    expect(command.params["proof-of-knowledge"]).toEqual(
      new Uint8Array([GROUP_DEVICE_BYTE]),
    );
    expect(command.params["existing-group-key"]).toBeUndefined();
  });

  it("buildKeygenRound1Command carries the reshare shape with existing-group-key, no proof-of-knowledge required", () => {
    const groupKey = new Uint8Array(DEVICE_ID_LENGTH).fill(GROUP_KEY_FILL_BYTE);
    const command = buildKeygenRound1Command(
      RESHARE_SESSION_ID,
      THRESHOLD,
      [deviceId(1)],
      [new Uint8Array([1])],
      { existingGroupKey: groupKey },
    );
    expect(command.verb).toBe(THRESHOLD_RESHARE_VERB);
    if (!isThresholdKeygenRound1(command.params)) {
      throw new Error("expected threshold.keygen-round1 params");
    }
    expect(command.params["existing-group-key"]).toEqual(groupKey);
    expect(command.params["proof-of-knowledge"]).toBeUndefined();
  });

  it("buildKeygenRound2Command and buildKeygenConfirmCommand use the given ceremony's own capability verb", () => {
    const round2 = buildKeygenRound2Command(
      ROUND2_CONFIRM_SESSION_ID,
      new Uint8Array([1]),
      true,
    );
    expect(round2.verb).toBe(THRESHOLD_RESHARE_VERB);
    expect(isThresholdKeygenRound2(round2.params)).toBe(true);

    const confirm = buildKeygenConfirmCommand(
      ROUND2_CONFIRM_SESSION_ID,
      new Uint8Array([1]),
      new Uint8Array([2]),
      false,
    );
    expect(confirm.verb).toBe(THRESHOLD_KEYGEN_VERB);
    expect(isThresholdKeygenConfirm(confirm.params)).toBe(true);
  });

  it("THRESHOLD_GROUP_SCOPE has no path -- the whole-scope root", () => {
    expect(THRESHOLD_GROUP_SCOPE).toEqual({ kind: "group" });
  });
});
