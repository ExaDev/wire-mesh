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
    const command = buildCommitCommand(1n, deviceId(9), subject, 1_000);
    expect(command.verb).toBe(THRESHOLD_SIGN_VERB);
    expect(isThresholdCommit(command.params)).toBe(true);
    if (!isThresholdCommit(command.params)) {
      throw new Error("expected threshold.commit params");
    }
    expect(command.params["session-id"]).toBe(1);
    expect(command.params.deadline).toBe(1_000);
    expect(command.params.subject).toEqual(subject);
  });

  it("buildSignCommand round-trips its commitments", () => {
    const commitments = [
      { participant: deviceId(1), hiding: new Uint8Array([1]), binding: new Uint8Array([2]) },
    ];
    const command = buildSignCommand(2n, commitments);
    expect(isThresholdSign(command.params)).toBe(true);
    if (!isThresholdSign(command.params)) {
      throw new Error("expected threshold.sign params");
    }
    expect(command.params.commitments).toEqual(commitments);
  });

  it("buildAbortCommand omits reason when not given, includes it when given", () => {
    const withoutReason = buildAbortCommand(3n);
    if (!isThresholdAbort(withoutReason.params)) {
      throw new Error("expected threshold.abort params");
    }
    expect(withoutReason.params.reason).toBeUndefined();

    const withReason = buildAbortCommand(3n, "timed out");
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
    const command = buildKeygenRound1Command(4n, 2, [deviceId(1), deviceId(2)], [new Uint8Array([1])], {
      proofOfKnowledge: new Uint8Array([9]),
    });
    expect(command.verb).toBe(THRESHOLD_KEYGEN_VERB);
    if (!isThresholdKeygenRound1(command.params)) {
      throw new Error("expected threshold.keygen-round1 params");
    }
    expect(command.params["proof-of-knowledge"]).toEqual(new Uint8Array([9]));
    expect(command.params["existing-group-key"]).toBeUndefined();
  });

  it("buildKeygenRound1Command carries the reshare shape with existing-group-key, no proof-of-knowledge required", () => {
    const groupKey = new Uint8Array(32).fill(7);
    const command = buildKeygenRound1Command(5n, 2, [deviceId(1)], [new Uint8Array([1])], {
      existingGroupKey: groupKey,
    });
    expect(command.verb).toBe(THRESHOLD_RESHARE_VERB);
    if (!isThresholdKeygenRound1(command.params)) {
      throw new Error("expected threshold.keygen-round1 params");
    }
    expect(command.params["existing-group-key"]).toEqual(groupKey);
    expect(command.params["proof-of-knowledge"]).toBeUndefined();
  });

  it("buildKeygenRound2Command and buildKeygenConfirmCommand use the given ceremony's own capability verb", () => {
    const round2 = buildKeygenRound2Command(6n, new Uint8Array([1]), true);
    expect(round2.verb).toBe(THRESHOLD_RESHARE_VERB);
    expect(isThresholdKeygenRound2(round2.params)).toBe(true);

    const confirm = buildKeygenConfirmCommand(
      6n,
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
