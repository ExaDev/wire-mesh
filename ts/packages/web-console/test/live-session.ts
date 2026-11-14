// A real MeshSession over an in-memory link a test drives: frames pushed into it arrive as the peer's, what the session sends is recorded, and the link can be made to refuse writes for a while, as one that has gone away does.

import {
  createMeshSession,
  type MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import type { Frame } from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Connection, Transport } from "wire-mesh-core/ports/transport";
import { createAsyncQueue } from "wire-mesh-core/domain/async-queue";

export interface LiveSession {
  session: MeshSession;
  /** Every frame the session has sent. */
  sent: Frame[];
  /** Delivers a frame to the session as the peer's. */
  push: (frame: Frame) => void;
  /** Makes later sends reject until acceptSends. */
  rejectSends: () => void;
  acceptSends: () => void;
  /** How many sends were rejected while rejectSends was in force. */
  rejectedSends: () => number;
}

export async function liveSession(
  identity: IdentityPort,
  domains: readonly string[],
): Promise<LiveSession> {
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
  const session = createMeshSession(transport, identity, { now: () => 0 });
  await session.connect("ws://node", [...domains]);

  return {
    session,
    sent,
    push: (frame) => {
      inbound.push(frame);
    },
    rejectSends: () => {
      refusing = true;
    },
    acceptSends: () => {
      refusing = false;
    },
    rejectedSends: () => rejected,
  };
}

/** The answer the session sent to request `requestId`, once it has. */
export function answerTo(
  sent: readonly Frame[],
  requestId: number,
): Frame | undefined {
  return sent.find(
    (frame) =>
      frame.type === "manage-response" && frame["request-id"] === requestId,
  );
}
