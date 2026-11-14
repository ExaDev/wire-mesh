// The data channel's open promise is handled from its creation: a channel that fails while the offer is still being negotiated, or an offer the peer refuses so nothing ever waits on the channel, is an expected end, not an unhandled rejection; the caller still sees the failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeshSession } from "wire-mesh-core/domain/mesh-session";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { createWebrtcNegotiator } from "../src/webrtc-negotiation.js";

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
  vi.unstubAllGlobals();
});

/** The one data channel the stub peer connection hands out, so a test can make it fail. */
const channelListeners: Record<string, (() => void)[]> = {};

class StubPeerConnection {
  addEventListener(): void {
    return undefined;
  }

  createDataChannel(): {
    binaryType: string;
    addEventListener: (type: string, listener: () => void) => void;
  } {
    return {
      binaryType: "",
      addEventListener: (type, listener) => {
        (channelListeners[type] ??= []).push(listener);
      },
    };
  }

  async createOffer(): Promise<{ sdp: string }> {
    return Promise.resolve({ sdp: "v=0" });
  }

  async setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    return undefined;
  }
}

const noIncoming: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({
    next: async () => Promise.resolve({ done: true, value: undefined }),
  }),
};

describe("WebrtcNegotiator.initiate", () => {
  it("leaves nothing unhandled when the data channel fails and the offer is then refused", async () => {
    vi.stubGlobal("RTCPeerConnection", StubPeerConnection);
    channelListeners.error = [];
    const identity = await createWebCryptoIdentity();
    const sendManageRequest = vi.fn<MeshSession["sendManageRequest"]>(
      async () => {
        for (const listener of channelListeners.error ?? []) listener();

        return Promise.resolve({ result: "error", code: "refused" });
      },
    );
    const negotiator = createWebrtcNegotiator(
      { sendManageRequest, incomingManageRequests: noIncoming },
      {
        identity,
        clock: { now: () => 0 },
        revocation: { entriesFor: async () => Promise.resolve([]) },
        iceServers: [],
        onIncomingConnection: () => undefined,
      },
    );

    await expect(negotiator.initiate()).rejects.toThrow(/offer rejected/);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(unhandled).toEqual([]);
  });
});
