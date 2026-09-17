import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import {
  buildBulkCancelCommand,
  buildBulkOpenCommand,
  buildBulkResumeCommand,
  createBulkReceiver,
  createBulkSender,
  storedTransferSource,
  type BulkOfferEvent,
  type BulkReceiveResult,
} from "../src/domain/bulk.js";
import type {
  CapabilityScope,
  DeviceId,
  Frame,
  ManageCommand,
} from "../src/generated/protocol.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "../src/domain/mesh-session.js";
import type { Connection } from "../src/ports/transport.js";
import { deviceIdFromFillHex } from "./hex.js";

const HEX_RADIX = 16;
const TRANSFER_ID_BYTE_LENGTH = 16;
const DIGEST_BYTE_LENGTH = 32;

/** A full synthetic transfer-id from a one-byte hex fill, mirroring hex.ts's own deviceIdFromFillHex convention but sized to transfer-id's own 16 bytes rather than a device-id's 32. */
function transferIdFromFillHex(fillHex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(TRANSFER_ID_BYTE_LENGTH);
  out.fill(Number.parseInt(fillHex, HEX_RADIX));
  return out;
}

function digestFromFillHex(fillHex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(DIGEST_BYTE_LENGTH);
  out.fill(Number.parseInt(fillHex, HEX_RADIX));
  return out;
}

const TEST_SCOPE: CapabilityScope = { kind: "folder", path: "/transfers" };
const TEST_ACK_SEQ = 3;
const SENDER_DEVICE: DeviceId = deviceIdFromFillHex("11");
const DEFAULT_WINDOW = 4096;

/** A one-directional, wake-on-push frame queue -- the same async-iterator-with-a-wait-queue shape mesh-session-fixtures.ts's own FakeConnection uses internally, factored out here so linkedConnections() below can compose two of them into a genuine bidirectional pair. */
class FakeInbound {
  private readonly queue: Frame[] = [];
  private readonly waiters: (() => void)[] = [];
  private ended = false;

  push(frame: Frame): void {
    this.queue.push(frame);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  stream(): AsyncIterable<Frame> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Frame>> => this.next(),
      }),
    };
  }

  private async next(): Promise<IteratorResult<Frame>> {
    for (;;) {
      const value = this.queue.shift();
      if (value !== undefined) return { value, done: false };
      if (this.ended) return { value: undefined, done: true };
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

/** Two Connections wired directly to each other: whatever senderConn.send() writes arrives on receiverConn.receive(), and vice versa -- the minimal two-sided link bulk.ts's sender/receiver need, independent of any MeshSession/handshake machinery. */
function linkedConnections(): {
  senderConn: Readonly<Connection>;
  receiverConn: Readonly<Connection>;
  endSenderSide: () => void;
  endReceiverSide: () => void;
} {
  const toReceiver = new FakeInbound();
  const toSender = new FakeInbound();
  const senderConn: Connection = {
    send: async (frame) => {
      toReceiver.push(frame);
      return Promise.resolve();
    },
    receive: () => toSender.stream(),
    close: async () => {
      toSender.end();
      return Promise.resolve();
    },
  };
  const receiverConn: Connection = {
    send: async (frame) => {
      toSender.push(frame);
      return Promise.resolve();
    },
    receive: () => toReceiver.stream(),
    close: async () => {
      toReceiver.end();
      return Promise.resolve();
    },
  };
  return {
    senderConn,
    receiverConn,
    endSenderSide: () => {
      toReceiver.end();
    },
    endReceiverSide: () => {
      toSender.end();
    },
  };
}

/** Pumps every frame arriving on a connection's own receive() into a callback, forever -- the "wire this as onFrame" integration point a real caller would set up via acceptMeshSession's own onFrame option, reproduced directly against the fake connections here since no real MeshSession is involved. onEnd, if given, fires once receive()'s own iteration reaches done:true -- the "wire this as onSessionEnd/onConnectionEnd" counterpart, needed by any test that actually interrupts a connection mid-transfer. */
function pump(
  connection: Readonly<Connection>,
  onFrame: (frame: Frame) => void | Promise<void>,
  onEnd?: () => void,
): void {
  void (async () => {
    for await (const frame of connection.receive()) {
      await onFrame(frame);
    }
    onEnd?.();
  })();
}

/** Wraps a manage-request handler as a MeshSession.sendManageRequest -- dispatches directly to the handler with a fake IncomingManageRequest, bypassing any real connection/handshake machinery, matching capability-request.test.ts's own fakeSession convention. */
function sessionDispatchingTo(
  handler: (incoming: IncomingManageRequest) => Promise<void>,
): MeshSession {
  return {
    async sendManageRequest(
      command: ManageCommand,
      scope: Readonly<CapabilityScope>,
    ): Promise<ManageOutcome> {
      // respond() is the real completion signal, not handler()'s own returned promise: createOpenHandler (like createCapabilityRequestHandler before it) invokes its onOffer/onRequest callback synchronously and returns without waiting for the caller's own decide() to resolve, exactly matching how a real network round-trip doesn't complete until respond() is actually called, however long that takes.
      let resolveOutcome: (outcome: ManageOutcome) => void = () => undefined;
      const responded = new Promise<ManageOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      const incoming: IncomingManageRequest = {
        requestId: 0,
        command,
        scope,
        respond: async (o): Promise<void> => {
          resolveOutcome(o);
          return Promise.resolve();
        },
      };
      await handler(incoming);
      return responded;
    },
  } as unknown as MeshSession;
}

function chunkedSource(
  data: readonly Uint8Array<ArrayBuffer>[],
): (fromSeq: number) => AsyncIterable<Uint8Array<ArrayBuffer>> {
  return (fromSeq: number) => ({
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array<ArrayBuffer>> {
      let i = fromSeq;
      return {
        next: async (): Promise<IteratorResult<Uint8Array<ArrayBuffer>>> => {
          const value = data[i];
          if (value === undefined) {
            return Promise.resolve({ value: undefined, done: true });
          }
          i += 1;
          return Promise.resolve({ value, done: false });
        },
      };
    },
  });
}

/** A promise a test can resolve from a callback fired asynchronously (e.g. onComplete, invoked from the receiver's own onFrame processing loop, which runs on a separate task from whatever awaited the sender's own send-side promise) -- lets the test genuinely wait for that callback rather than racing it. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe("buildBulkOpenCommand / buildBulkResumeCommand / buildBulkCancelCommand", () => {
  const transferId = transferIdFromFillHex("aa");

  it("builds bulk.open under the bulk:write outer verb", () => {
    expect(buildBulkOpenCommand(transferId)).toEqual({
      verb: "bulk:write",
      params: { verb: "bulk.open", "transfer-id": transferId },
    } satisfies ManageCommand);
  });

  it("includes total-size/content-type only when given", () => {
    expect(
      buildBulkOpenCommand(transferId, {
        totalSize: 10,
        contentType: "text/plain",
      }),
    ).toEqual({
      verb: "bulk:write",
      params: {
        verb: "bulk.open",
        "transfer-id": transferId,
        "total-size": 10,
        "content-type": "text/plain",
      },
    } satisfies ManageCommand);
  });

  it("builds bulk.resume under the bulk:read outer verb", () => {
    expect(buildBulkResumeCommand(transferId, TEST_ACK_SEQ)).toEqual({
      verb: "bulk:read",
      params: {
        verb: "bulk.resume",
        "transfer-id": transferId,
        "ack-seq": TEST_ACK_SEQ,
      },
    } satisfies ManageCommand);
  });

  it("builds bulk.cancel under the caller-given capability", () => {
    expect(
      buildBulkCancelCommand(transferId, "bulk:write", "no longer needed"),
    ).toEqual({
      verb: "bulk:write",
      params: {
        verb: "bulk.cancel",
        "transfer-id": transferId,
        reason: "no longer needed",
      },
    } satisfies ManageCommand);
  });
});

describe("bulk sender/receiver, end to end", () => {
  it("transfers a small multi-chunk payload and the receiver durably persists it", async () => {
    const chunks = ["hello ", "bulk ", "world"].map((s) =>
      new TextEncoder().encode(s),
    );
    const expected = concat(chunks);

    const { senderConn, receiverConn } = linkedConnections();
    const storage = createMemoryStorage();
    const receiver = createBulkReceiver({ storage });
    const sender = createBulkSender({ source: chunkedSource(chunks) });
    const transferId = transferIdFromFillHex("01");

    const complete = deferred<BulkReceiveResult>();
    const openHandler = receiver.createOpenHandler(
      SENDER_DEVICE,
      receiverConn,
      (event: Readonly<BulkOfferEvent>) => {
        void event.decide({
          kind: "accept",
          window: DEFAULT_WINDOW,
          onComplete: complete.resolve,
        });
      },
    );
    const senderSession = sessionDispatchingTo(openHandler);

    pump(senderConn, (frame) => {
      sender.onFrame(senderConn, frame);
    });
    pump(receiverConn, async (frame) => receiver.onFrame(receiverConn, frame));

    const outcome = await sender.open(senderConn, senderSession, TEST_SCOPE, {
      transferId,
    });

    expect(outcome.status).toBe("complete");
    expect(outcome.ackedCount).toBe(chunks.length);
    // The sender's own promise resolving only proves the final bulk-end frame was sent, not that the receiver (processing it on its own, separately-scheduled onFrame pump) has finished verifying it yet -- await the receiver's own completion signal instead of racing it.
    expect(await complete.promise).toEqual({
      ok: true,
      chunkCount: chunks.length,
    });

    const idHex = "01".repeat(TRANSFER_ID_BYTE_LENGTH);
    const reconstructed = new Uint8Array(expected.length);
    let offset = 0;
    for (let seq = 0; seq < chunks.length; seq += 1) {
      const stored = await storage.get(`bulk/${idHex}/chunk/${String(seq)}`);
      expect(stored).toBeDefined();
      if (stored !== undefined) {
        reconstructed.set(stored, offset);
        offset += stored.length;
      }
    }
    expect(reconstructed).toEqual(expected);
  });

  it("rejects when the receiver declines the offer", async () => {
    const chunks = [new TextEncoder().encode("x")];
    const { senderConn, receiverConn } = linkedConnections();
    const receiver = createBulkReceiver({ storage: createMemoryStorage() });
    const sender = createBulkSender({ source: chunkedSource(chunks) });

    const openHandler = receiver.createOpenHandler(
      SENDER_DEVICE,
      receiverConn,
      (event) => {
        void event.decide({ kind: "reject", reason: "no thanks" });
      },
    );
    const senderSession = sessionDispatchingTo(openHandler);

    const outcome = await sender.open(senderConn, senderSession, TEST_SCOPE);

    expect(outcome.status).toBe("rejected");
    expect(outcome.code).toBe("denied");
  });

  it("refuses a second bulk.open for a transfer-id it already accepted", async () => {
    const transferId = transferIdFromFillHex("02");
    const { receiverConn } = linkedConnections();
    const receiver = createBulkReceiver({ storage: createMemoryStorage() });
    const openHandler = receiver.createOpenHandler(
      SENDER_DEVICE,
      receiverConn,
      (event) => {
        void event.decide({ kind: "accept", window: DEFAULT_WINDOW });
      },
    );

    const first: IncomingManageRequest = {
      requestId: 1,
      command: buildBulkOpenCommand(transferId),
      scope: TEST_SCOPE,
      respond: async () => Promise.resolve(),
    };
    await openHandler(first);

    let secondOutcome: ManageOutcome | undefined;
    const second: IncomingManageRequest = {
      requestId: 2,
      command: buildBulkOpenCommand(transferId),
      scope: TEST_SCOPE,
      respond: async (o): Promise<void> => {
        secondOutcome = o;
        return Promise.resolve();
      },
    };
    await openHandler(second);

    expect(secondOutcome).toEqual({
      result: "error",
      code: "already_exists",
    });
  });

  it("detects a corrupted transfer via a digest mismatch", async () => {
    const chunk = new TextEncoder().encode("payload");
    const { receiverConn } = linkedConnections();
    const receiver = createBulkReceiver({ storage: createMemoryStorage() });
    const transferId = transferIdFromFillHex("03");

    const complete = deferred<BulkReceiveResult>();
    const accepted = deferred<undefined>();
    const openHandler = receiver.createOpenHandler(
      SENDER_DEVICE,
      receiverConn,
      (event) => {
        // decide() is async and openHandler itself does not wait for it (matching createCapabilityRequestHandler's own onRequest/decide split), so awaiting openHandler alone does not prove the transfer is registered yet -- await this promise instead before sending any data frame.
        event
          .decide({
            kind: "accept",
            window: DEFAULT_WINDOW,
            onComplete: complete.resolve,
          })
          .then(() => {
            accepted.resolve(undefined);
          })
          .catch(() => undefined);
      },
    );
    await openHandler({
      requestId: 1,
      command: buildBulkOpenCommand(transferId),
      scope: TEST_SCOPE,
      respond: async () => Promise.resolve(),
    });
    await accepted.promise;

    await receiver.onFrame(receiverConn, {
      type: "bulk-data",
      "transfer-id": transferId,
      seq: 0,
      bytes: chunk,
    });
    await receiver.onFrame(receiverConn, {
      type: "bulk-end",
      "transfer-id": transferId,
      digest: digestFromFillHex("ff"), // deliberately wrong
    });

    expect(await complete.promise).toEqual({ ok: false, chunkCount: 1 });
  });

  it("resumes an interrupted transfer on a fresh connection from the receiver's own ack-seq", async () => {
    const chunks = ["aaaa", "bbbb", "cccc"].map((s) =>
      new TextEncoder().encode(s),
    );
    const expected = concat(chunks);
    const transferId = transferIdFromFillHex("04");
    const storage = createMemoryStorage();
    const receiver = createBulkReceiver({ storage });
    const sender = createBulkSender({ source: chunkedSource(chunks) });

    const link1 = linkedConnections();
    const complete = deferred<BulkReceiveResult>();
    const firstChunkLength = chunks[0]?.length ?? 0;
    const openHandler = receiver.createOpenHandler(
      SENDER_DEVICE,
      link1.receiverConn,
      (event) => {
        void event.decide({
          // Window sized for exactly one chunk at a time -- guarantees the sender must wait for an ack before its second chunk, so the mid-transfer cutoff below lands deterministically between chunk 0 and chunk 1.
          kind: "accept",
          window: firstChunkLength,
          onComplete: complete.resolve,
        });
      },
    );
    const senderSession1 = sessionDispatchingTo(openHandler);

    pump(
      link1.senderConn,
      (frame) => {
        sender.onFrame(link1.senderConn, frame);
      },
      () => {
        sender.onConnectionEnd(link1.senderConn);
      },
    );
    let sawSecondChunkSent = false;
    pump(link1.receiverConn, async (frame) => {
      if (frame.type === "bulk-data" && frame.seq === 1) {
        sawSecondChunkSent = true;
        link1.endReceiverSide();
        return;
      }
      await receiver.onFrame(link1.receiverConn, frame);
    });

    const firstAttempt = await sender.open(
      link1.senderConn,
      senderSession1,
      TEST_SCOPE,
      { transferId },
    );
    expect(firstAttempt.status).toBe("incomplete");
    expect(sawSecondChunkSent).toBe(true);
    expect(firstAttempt.ackedCount).toBe(1);

    // Fresh connection: the receiver actively requests resumption from its own durably-persisted ack-seq (1 chunk already durable).
    const link2 = linkedConnections();
    const resumeHandler = sender.createResumeHandler(link2.senderConn);
    pump(link2.senderConn, (frame) => {
      if (frame.type === "bulk-ack" || frame.type === "bulk-end") {
        sender.onFrame(link2.senderConn, frame);
      }
    });
    pump(link2.receiverConn, async (frame) =>
      receiver.onFrame(link2.receiverConn, frame),
    );
    const senderSession2 = sessionDispatchingTo(resumeHandler);

    const resumeResult = await receiver.requestResume(
      link2.receiverConn,
      senderSession2,
      transferId,
      TEST_SCOPE,
    );
    expect(resumeResult.status).toBe("ok");

    // The resumed stream runs asynchronously off the manage-response above (sender.createResumeHandler fires it after responding, not awaited by requestResume itself) -- await the receiver's own completion signal rather than an arbitrary delay.
    expect(await complete.promise).toEqual({
      ok: true,
      chunkCount: chunks.length,
    });
    const idHex = "04".repeat(TRANSFER_ID_BYTE_LENGTH);
    const reconstructed = new Uint8Array(expected.length);
    let offset = 0;
    for (let seq = 0; seq < chunks.length; seq += 1) {
      const stored = await storage.get(`bulk/${idHex}/chunk/${String(seq)}`);
      expect(stored).toBeDefined();
      if (stored !== undefined) {
        reconstructed.set(stored, offset);
        offset += stored.length;
      }
    }
    expect(reconstructed).toEqual(expected);
  });

  it("stops sending once the sender's own createCancelHandler marks a transfer cancelled", async () => {
    const chunks = ["a", "b", "c"].map((s) => new TextEncoder().encode(s));
    const { senderConn, receiverConn } = linkedConnections();
    const receiver = createBulkReceiver({ storage: createMemoryStorage() });
    const sender = createBulkSender({ source: chunkedSource(chunks) });
    const transferId = transferIdFromFillHex("05");

    const openHandler = receiver.createOpenHandler(
      SENDER_DEVICE,
      receiverConn,
      (event) => {
        void event.decide({ kind: "accept", window: DEFAULT_WINDOW });
      },
    );
    const senderSession = sessionDispatchingTo(openHandler);
    pump(senderConn, (frame) => {
      sender.onFrame(senderConn, frame);
    });
    pump(receiverConn, async (frame) => receiver.onFrame(receiverConn, frame));

    const cancelHandler = sender.createCancelHandler();
    const cancelIncoming: IncomingManageRequest = {
      requestId: 9,
      command: buildBulkCancelCommand(transferId, "bulk:write"),
      scope: TEST_SCOPE,
      respond: async () => Promise.resolve(),
    };
    // Cancel arrives before open() is even called -- proves cancellation is tracked independently of any one in-flight stream() call, not just as a mid-loop flag on a call that's already running.
    await cancelHandler(cancelIncoming);

    const outcome = await sender.open(senderConn, senderSession, TEST_SCOPE, {
      transferId,
    });

    expect(outcome.status).toBe("incomplete");
    expect(outcome.ackedCount).toBe(0);
  });
});

describe("storedTransferSource", () => {
  it("reads back a fully-received transfer's chunks in order, from a given fromSeq", async () => {
    const chunks = ["one", "two", "three"].map((s) =>
      new TextEncoder().encode(s),
    );
    const { senderConn, receiverConn } = linkedConnections();
    const storage = createMemoryStorage();
    const receiver = createBulkReceiver({ storage });
    const sender = createBulkSender({ source: chunkedSource(chunks) });
    const transferId = transferIdFromFillHex("21");

    const complete = deferred<BulkReceiveResult>();
    const openHandler = receiver.createOpenHandler(
      SENDER_DEVICE,
      receiverConn,
      (event: Readonly<BulkOfferEvent>) => {
        void event.decide({
          kind: "accept",
          window: DEFAULT_WINDOW,
          onComplete: complete.resolve,
        });
      },
    );
    const senderSession = sessionDispatchingTo(openHandler);
    pump(senderConn, (frame) => {
      sender.onFrame(senderConn, frame);
    });
    pump(receiverConn, async (frame) => receiver.onFrame(receiverConn, frame));
    await sender.open(senderConn, senderSession, TEST_SCOPE, { transferId });
    await complete.promise;

    const source = storedTransferSource({ storage, transferId });
    const readBack: Uint8Array[] = [];
    for await (const chunk of source(0)) readBack.push(chunk);
    expect(readBack).toEqual(chunks);

    const fromMiddle: Uint8Array[] = [];
    for await (const chunk of source(1)) fromMiddle.push(chunk);
    expect(fromMiddle).toEqual(chunks.slice(1));
  });

  it("yields nothing for a transfer-id this storage never durably received", async () => {
    const storage = createMemoryStorage();
    const source = storedTransferSource({
      storage,
      transferId: transferIdFromFillHex("22"),
    });
    const readBack: Uint8Array[] = [];
    for await (const chunk of source(0)) readBack.push(chunk);
    expect(readBack).toEqual([]);
  });

  it("is callable more than once and yields identical bytes each time, the same re-readability contract every other CreateBulkSenderOptions.source must satisfy", async () => {
    const chunks = ["x", "y"].map((s) => new TextEncoder().encode(s));
    const { senderConn, receiverConn } = linkedConnections();
    const storage = createMemoryStorage();
    const receiver = createBulkReceiver({ storage });
    const sender = createBulkSender({ source: chunkedSource(chunks) });
    const transferId = transferIdFromFillHex("23");
    const complete = deferred<BulkReceiveResult>();
    const openHandler = receiver.createOpenHandler(
      SENDER_DEVICE,
      receiverConn,
      (event: Readonly<BulkOfferEvent>) => {
        void event.decide({
          kind: "accept",
          window: DEFAULT_WINDOW,
          onComplete: complete.resolve,
        });
      },
    );
    const senderSession = sessionDispatchingTo(openHandler);
    pump(senderConn, (frame) => {
      sender.onFrame(senderConn, frame);
    });
    pump(receiverConn, async (frame) => receiver.onFrame(receiverConn, frame));
    await sender.open(senderConn, senderSession, TEST_SCOPE, { transferId });
    await complete.promise;

    const source = storedTransferSource({ storage, transferId });
    const first: Uint8Array[] = [];
    for await (const chunk of source(0)) first.push(chunk);
    const second: Uint8Array[] = [];
    for await (const chunk of source(0)) second.push(chunk);
    expect(second).toEqual(first);
  });
});
