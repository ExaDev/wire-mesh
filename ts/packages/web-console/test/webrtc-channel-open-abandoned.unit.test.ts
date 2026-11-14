// The data channel's open promise is handled from its creation: a channel that fails while the offer is still being negotiated, or an offer the peer refuses so nothing ever waits on the channel, is an expected end, not an unhandled rejection; the caller still sees the failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeshSession } from "wire-mesh-core/domain/mesh-session";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { createWebrtcNegotiator } from "../src/webrtc-negotiation.js";

const unhandled: unknown[] = [];
function recordUnhandled(reason: unknown): void {
  unhandled.push(reason);
}

/** Every peer connection the stub has had close() called on. */
const closedConnections: unknown[] = [];

beforeEach(() => {
  closedConnections.length = 0;
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

  closed = 0;

  close(): void {
    closedConnections.push(this);
    this.closed += 1;
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

  const OPEN_TIMEOUT_MS = 1_000;

  async function negotiatorWith(
    sendManageRequest: MeshSession["sendManageRequest"],
  ): Promise<ReturnType<typeof createWebrtcNegotiator>> {
    vi.stubGlobal("RTCPeerConnection", StubPeerConnection);
    channelListeners.error = [];
    const identity = await createWebCryptoIdentity();

    return createWebrtcNegotiator(
      { sendManageRequest, incomingManageRequests: noIncoming },
      {
        identity,
        clock: { now: () => 0 },
        revocation: { entriesFor: async () => Promise.resolve([]) },
        iceServers: [],
        onIncomingConnection: () => undefined,
        channelOpenTimeoutMs: OPEN_TIMEOUT_MS,
      },
    );
  }

  it("closes its peer connection when the offer cannot be sent", async () => {
    const negotiator = await negotiatorWith(async () =>
      Promise.reject(new Error("the session is not connected")),
    );

    await expect(negotiator.initiate()).rejects.toThrow("not connected");
    expect(closedConnections).toHaveLength(1);
  });

  it("closes its peer connection when the data channel fails after the offer is accepted", async () => {
    const negotiator = await negotiatorWith(async () => {
      queueMicrotask(() => {
        for (const listener of channelListeners.error ?? []) listener();
      });

      return Promise.resolve({ result: "ok" });
    });

    await expect(negotiator.initiate()).rejects.toThrow(/failed to open/);
    expect(closedConnections).toHaveLength(1);
  });

  it("gives up on a data channel that neither opens nor fails, and closes its peer connection", async () => {
    vi.useFakeTimers();
    try {
      const negotiator = await negotiatorWith(async () =>
        Promise.resolve({ result: "ok" }),
      );
      const outcome = expect(negotiator.initiate()).rejects.toThrow(
        /did not open in time/,
      );
      // The bound starts once the offer is accepted, after real asynchronous steps.
      await vi.waitFor(() => {
        expect(vi.getTimerCount()).toBe(1);
      });
      await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
      await outcome;

      expect(closedConnections).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
