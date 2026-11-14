// The SFU's loop over one participant's incoming requests, over a real MeshSession: a request whose handling fails (its answer cannot be sent because the link refuses writes) is contained to it, reported once, and the participant's next request is still served, with no unhandled rejection.

import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import {
  createMeshSession,
  type MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import { createAsyncQueue } from "wire-mesh-core/domain/async-queue";
import { buildAnswerCommand } from "wire-mesh-core/domain/webrtc-signaling";
import type { Frame } from "wire-mesh-core/generated/protocol";
import type { Connection, Transport } from "wire-mesh-core/ports/transport";
import { createSfuCall } from "../src/domain/sfu-session.js";
import type { SfuMediaBackend } from "../src/domain/media-backend.js";

const ES256 = -7;
const FIRST_REQUEST = 31;
const SECOND_REQUEST = 32;
const NEGOTIATION_ID = 3;

const unhandled: unknown[] = [];
function recordUnhandled(reason: unknown): void {
  unhandled.push(reason);
}

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", recordUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", recordUnhandled);
});

async function identity(): ReturnType<typeof createNodeIdentity> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );

  return createNodeIdentity(keyPair.privateKey, publicKeyBytes, ES256);
}

interface Link {
  session: MeshSession;
  sent: Frame[];
  push: (frame: Frame) => void;
  rejectSends: (on: boolean) => void;
  rejected: () => number;
}

async function link(): Promise<Link> {
  const inbound = createAsyncQueue<Frame>();
  const sent: Frame[] = [];
  let refusing = false;
  let rejected = 0;
  const connection: Connection = {
    send: async (frame) => {
      if (refusing) {
        rejected += 1;
        throw new Error("the link stopped accepting writes");
      }
      sent.push(frame);

      return Promise.resolve();
    },
    receive: () => inbound.stream,
    close: async () => Promise.resolve(),
  };
  const transport: Transport = {
    connect: async () => Promise.resolve(connection),
    listen: async () => Promise.reject(new Error("client-only transport")),
  };
  const session = createMeshSession(transport, await identity(), {
    now: () => 0,
  });
  await session.connect("ws://node", ["core/webrtc"]);

  return {
    session,
    sent,
    push: (frame) => {
      inbound.push(frame);
    },
    rejectSends: (on) => {
      refusing = on;
    },
    rejected: () => rejected,
  };
}

describe("the SFU's loop over a participant's requests", () => {
  it("serves the request after one whose answer could not be sent, and reports the failure once", async () => {
    const participant = await link();
    const faults: unknown[] = [];
    const backend = {} as SfuMediaBackend;
    const call = createSfuCall(
      backend,
      {
        identity: await identity(),
        clock: { now: () => 0 },
        revocation: { entriesFor: async () => Promise.resolve([]) },
      },
      {
        onFault: (error) => {
          faults.push(error);
        },
      },
    );
    void call.addParticipant(
      Uint8Array.from({ length: 32 }, () => 1),
      participant.session,
    );
    // An answer is one an ordinary participant never sends: the SFU answers it with an error, which the session has to send.
    const answer = (requestId: number): Frame => ({
      type: "manage-request",
      "request-id": requestId,
      command: buildAnswerCommand(NEGOTIATION_ID, "v=0"),
      scope: { kind: "node" },
    });

    const before = participant.rejected();
    participant.rejectSends(true);
    participant.push(answer(FIRST_REQUEST));
    await vi.waitFor(() => {
      if (participant.rejected() <= before) throw new Error("not yet");
    });
    participant.rejectSends(false);
    participant.push(answer(SECOND_REQUEST));

    await vi.waitFor(() => {
      expect(
        participant.sent.find(
          (frame) =>
            frame.type === "manage-response" &&
            frame["request-id"] === SECOND_REQUEST,
        ),
      ).toMatchObject({
        outcome: { result: "error", code: "unexpected-verb" },
      });
    });
    expect(faults).toHaveLength(1);
    expect(unhandled).toEqual([]);
    await participant.session.close();
  });
});
