import { describe, expect, it } from "vitest";
import { startThresholdParticipant } from "../src/adapters/threshold-participant.js";
import { createMemoryNonceStore } from "../src/adapters/memory-nonce-store.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import { buildCommitCommand } from "../src/domain/threshold-network.js";
import { THRESHOLD_GROUP_SCOPE } from "../src/domain/threshold-network.js";
import type { DeviceId } from "../src/generated/protocol.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "../src/domain/mesh-session.js";
import type { ThresholdSubject } from "../src/domain/threshold-subject.js";
import { mintCapabilityToken } from "../src/domain/tokens.js";
import {
  fixedClock,
  generateEd25519Identity,
  neverRevoked,
} from "./tokens-fixtures.js";

const DEVICE_ID_LENGTH = 32;
const NOW_MS = 1_000_000;
const HOUR_MS = 3_600_000;
const SOON_MS = 1_000;
const GROUP_DEVICE_BYTE = 9;
const FIRST_REQUEST_ID = 0;
const SESSION_ID = 1n;

function deviceId(byte: number): DeviceId {
  const bytes = new Uint8Array(DEVICE_ID_LENGTH);
  bytes[DEVICE_ID_LENGTH - 1] = byte;
  return bytes;
}

/** Sends one bare manage-request directly into a participant's own consume loop (bypassing any coordinator), and resolves with the manage-response it produces -- everything these tests need to exercise a single request/response in isolation. */
async function sendOnce(
  push: (incoming: IncomingManageRequest) => void,
  requestId: number,
  incoming: Omit<IncomingManageRequest, "requestId" | "respond">,
): Promise<ManageOutcome> {
  return new Promise((resolve) => {
    push({
      requestId,
      ...incoming,
      respond: async (outcome) => {
        resolve(outcome);
        return Promise.resolve();
      },
    });
  });
}

function participantHarness(): {
  push: (incoming: IncomingManageRequest) => void;
  session: { incomingManageRequests: AsyncIterable<IncomingManageRequest> };
} {
  const waiters: ((request: IncomingManageRequest) => void)[] = [];
  const backlog: IncomingManageRequest[] = [];
  return {
    push: (incoming) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(incoming);
      } else {
        backlog.push(incoming);
      }
    },
    session: {
      incomingManageRequests: {
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<IncomingManageRequest>> =>
              new Promise((resolve) => {
                const item = backlog.shift();
                if (item) {
                  resolve({ value: item, done: false });
                } else {
                  waiters.push((request) => {
                    resolve({ value: request, done: false });
                  });
                }
              }),
          };
        },
      },
    },
  };
}

const subject: ThresholdSubject = {
  kind: "capability-token",
  protected: new Uint8Array([1]),
  payload: new Uint8Array([2]),
};

describe("threshold-participant: fail-closed paths", () => {
  it("refuses a request with no capability token", async () => {
    const harness = participantHarness();
    const personal = await generateEd25519Identity();
    startThresholdParticipant({
      session: harness.session,
      personalIdentity: personal,
      keyPackagesByGroup: new Map(),
      nonceStore: createMemoryNonceStore(),
      clock: fixedClock(NOW_MS),
      revocation: neverRevoked,
    });

    const command = buildCommitCommand(
      SESSION_ID,
      deviceId(GROUP_DEVICE_BYTE),
      subject,
      NOW_MS + SOON_MS,
    );
    const outcome = await sendOnce(harness.push, FIRST_REQUEST_ID, {
      command,
      scope: THRESHOLD_GROUP_SCOPE,
    });
    expect(outcome).toEqual({ result: "error", code: "unauthorized" });
  });

  it("refuses a group this participant holds no key package for", async () => {
    const harness = participantHarness();
    const personal = await generateEd25519Identity();
    const root = await generateEd25519Identity();
    const clock = fixedClock(NOW_MS);
    const mint = await mintCapabilityToken({
      identity: root,
      clock,
      tokenId: new Uint8Array([1]),
      bearer: personal.deviceId,
      capability: "exadev.io/threshold:sign",
      scope: { kind: "group" },
      expires: NOW_MS + HOUR_MS,
    });
    if (!mint.ok) {
      throw new Error(`test fixture: token mint failed: ${mint.reason}`);
    }
    const { token } = mint;

    startThresholdParticipant({
      session: harness.session,
      personalIdentity: personal,
      keyPackagesByGroup: new Map(), // no group known
      nonceStore: createMemoryNonceStore(),
      clock,
      revocation: neverRevoked,
    });

    const command = buildCommitCommand(
      SESSION_ID,
      deviceId(GROUP_DEVICE_BYTE),
      subject,
      NOW_MS + SOON_MS,
    );
    const outcome = await sendOnce(harness.push, FIRST_REQUEST_ID, {
      command,
      scope: THRESHOLD_GROUP_SCOPE,
      token,
    });
    expect(outcome).toEqual({ result: "error", code: "unknown-group" });
  });

  it("refuses a commit whose deadline has already passed", async () => {
    const harness = participantHarness();
    const personal = await generateEd25519Identity();
    const root = await generateEd25519Identity();
    const clock = fixedClock(NOW_MS);
    const mint = await mintCapabilityToken({
      identity: root,
      clock,
      tokenId: new Uint8Array([2]),
      bearer: personal.deviceId,
      capability: "exadev.io/threshold:sign",
      scope: { kind: "group" },
      expires: NOW_MS + HOUR_MS,
    });
    if (!mint.ok) {
      throw new Error(`test fixture: token mint failed: ${mint.reason}`);
    }
    const { token } = mint;

    startThresholdParticipant({
      session: harness.session,
      personalIdentity: personal,
      keyPackagesByGroup: new Map([
        [deviceIdToHex(deviceId(GROUP_DEVICE_BYTE)), new Uint8Array()],
      ]),
      nonceStore: createMemoryNonceStore(),
      clock,
      revocation: neverRevoked,
    });

    const command = buildCommitCommand(
      SESSION_ID,
      deviceId(GROUP_DEVICE_BYTE),
      subject,
      NOW_MS - 1,
    );
    const outcome = await sendOnce(harness.push, FIRST_REQUEST_ID, {
      command,
      scope: THRESHOLD_GROUP_SCOPE,
      token,
    });
    expect(outcome).toEqual({ result: "error", code: "deadline-passed" });
  });
});
