// A Connection implementation over an already-connected RTCDataChannel, the same message convention as the WebSocket adapter: RTCDataChannel delivers one whole message per send() (message-based, not a byte stream, in its default reliable/ordered mode -- the same guarantee WebSocket messages already give the CBOR framing here), so one send() call carries exactly one CBOR-encoded frame with no length prefix. Undecodable bytes are a connection-level failure (the receive iteration rejects and the channel closes), matching the WebSocket adapter's treatment of hostile wire input; a decodable frame that fails schema validation is dropped rather than disconnecting. This module does no signaling of its own -- it only wraps a channel that has already reached "open", handed to it by webrtc-negotiation.ts once offer/answer/ICE negotiation completes.
//
// Exactly like createBrowserTransport's connect() sets ws.binaryType before calling wrapWebSocket, the caller here (webrtc-negotiation.ts) must set channel.binaryType = "arraybuffer" explicitly -- not relied on as an unstated default -- on the still-mutable channel before handing it to wrapRtcDataChannel. This adapter takes a Readonly channel and never mutates it itself.

import type { Frame } from "@exadev/wire-mesh-core/generated/protocol";
import type { Connection } from "@exadev/wire-mesh-core/ports/transport";
import {
  SchemaInvalidFrameError,
  decodeMessage,
  messageFromFrame,
} from "@exadev/wire-mesh-core/adapters/frame-codec";

export function wrapRtcDataChannel(
  channel: Readonly<RTCDataChannel>,
): Connection {
  const pending: Frame[] = [];
  const waiters: {
    resolve: (result: IteratorResult<Frame>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let ended = false;
  let failure: Error | null = null;

  function endAll(): void {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  function failAll(error: Error): void {
    failure = error;
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  channel.addEventListener("message", (event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) {
      // Only binary messages carry frames; a text message is a protocol violation on this connection, same class as undecodable bytes.
      failAll(new Error("expected a binary data channel message"));
      channel.close();
      return;
    }
    let frame: Frame;
    try {
      frame = decodeMessage(event.data);
    } catch (error) {
      if (error instanceof SchemaInvalidFrameError) {
        return;
      }
      failAll(
        error instanceof Error
          ? error
          : new Error(`frame body failed to decode: ${String(error)}`),
      );
      channel.close();
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve({ value: frame, done: false });
    } else {
      pending.push(frame);
    }
  });
  channel.addEventListener("close", endAll);
  channel.addEventListener("error", endAll);

  const receiveStream: AsyncIterable<Frame> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<Frame>> => receiveNext(),
      };
    },
  };

  async function receiveNext(): Promise<IteratorResult<Frame>> {
    const next = pending.shift();
    if (next !== undefined) {
      return Promise.resolve({ value: next, done: false });
    }
    if (failure !== null) {
      return Promise.reject(failure);
    }
    if (ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  return {
    async send(frame): Promise<void> {
      if (channel.readyState !== "open") {
        return Promise.reject(
          new Error(`data channel is not open (state: ${channel.readyState})`),
        );
      }
      channel.send(messageFromFrame(frame));
      return Promise.resolve();
    },
    receive: () => receiveStream,
    async close(): Promise<void> {
      channel.close();
      return Promise.resolve();
    },
  };
}
