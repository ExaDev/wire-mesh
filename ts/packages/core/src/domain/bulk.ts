/**
 * core/bulk (wire-mesh#34/#123): resumable, flow-controlled bulk transfer. `bulk.open`/`bulk.resume`/`bulk.cancel` ride manage-request-frame as ordinary manage-command params; `bulk-data`/`bulk-ack`/`bulk-end` are their own frame kind, riding the connection directly rather than a manage-response -- see spec/bulk.cddl's own header comment for the full design, including the three previously-open questions this module resolves in code (chunk-size negotiation is not a wire concept at all; transfer-id/issuer pairing is a verifier obligation, not a wire field; token expiry is checked once per manage-command, never per data frame).
 *
 * Two long-lived, connection-independent coordinators, not a single monolithic object: createBulkReceiver's own state (which transfer-id maps to which connection, and every durably-persisted chunk) must outlive any one connection for resumption to mean anything, so it is constructed once and its onFrame/createOpenHandler/createResumeHandler are wired into every connection a caller accepts, not recreated per connection. createBulkSender is scoped to what it can honestly promise: MeshSession itself has no mechanism that hands a caller a fresh Connection across a reconnect (acceptMeshSession's own doc comment says so explicitly), so open()/continueFrom() each operate over one connection and settle once that connection ends: the caller -- who already owns whatever reconnection policy it uses -- decides when to call continueFrom() again on a fresh connection, typically from its own createResumeHandler once the receiver's bulk.resume names a transfer this sender still remembers.
 */

import {
  bulkCancelSchema,
  bulkOpenSchema,
  bulkResumeSchema,
  type BulkAckFrame,
  type BulkDataFrame,
  type BulkEndFrame,
  type CapabilityScope,
  type CapabilityToken,
  type DeviceId,
  type Frame,
  type ManageCommand,
} from "../generated/protocol.js";
import type { IncomingManageRequest, MeshSession } from "./mesh-session.js";
import type { Connection } from "../ports/transport.js";
import type { KeyValueStorage } from "../ports/storage.js";
import { bytesToHex } from "./device-id.js";

const TRANSFER_ID_BYTE_LENGTH = 16;

/** The two capabilities matching the direction each manage-command actually flows (spec/bulk.cddl): the sender proves write authority to open a transfer, the receiver proves read authority to ask for one to continue. */
export const BULK_WRITE_CAPABILITY = "bulk:write";
export const BULK_READ_CAPABILITY = "bulk:read";

function randomTransferId(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(TRANSFER_ID_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytes;
}

function transferIdHex(transferId: Uint8Array): string {
  return bytesToHex(transferId);
}

async function digestOf(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return new Uint8Array(buffer);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------

export function buildBulkOpenCommand(
  transferId: Uint8Array<ArrayBuffer>,
  options: Readonly<{ totalSize?: number; contentType?: string }> = {},
): ManageCommand {
  return {
    verb: BULK_WRITE_CAPABILITY,
    params: {
      verb: "bulk.open",
      "transfer-id": transferId,
      ...(options.totalSize !== undefined
        ? { "total-size": options.totalSize }
        : {}),
      ...(options.contentType !== undefined
        ? { "content-type": options.contentType }
        : {}),
    },
  };
}

export function buildBulkResumeCommand(
  transferId: Uint8Array<ArrayBuffer>,
  ackSeq: number,
): ManageCommand {
  return {
    verb: BULK_READ_CAPABILITY,
    params: {
      verb: "bulk.resume",
      "transfer-id": transferId,
      "ack-seq": ackSeq,
    },
  };
}

export function buildBulkCancelCommand(
  transferId: Uint8Array<ArrayBuffer>,
  capability: typeof BULK_WRITE_CAPABILITY | typeof BULK_READ_CAPABILITY,
  reason?: string,
): ManageCommand {
  return {
    verb: capability,
    params: {
      verb: "bulk.cancel",
      "transfer-id": transferId,
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

// ---------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------

export interface BulkSendOutcome {
  status: "complete" | "incomplete" | "rejected";
  /** Count of chunks the receiver had acked as durably persisted when this call settled. */
  ackedCount: number;
  /** Present only when status is "rejected": the manage-error code the receiver responded with. */
  code?: string;
}

export interface CreateBulkSenderOptions {
  /**
   * Yields every chunk of the transfer starting at `fromSeq` (0 for a fresh transfer) -- MUST be callable more than once, from any previously-reached seq, and yield the identical bytes each time (spec/bulk.cddl's own "a file is inherently durable/re-readable" design point): this is what makes both mid-transfer resume and the post-transfer digest re-derivation below correct without this module buffering the whole transfer in memory during the send itself.
   */
  source: (fromSeq: number) => AsyncIterable<Uint8Array<ArrayBuffer>>;
}

interface PendingAck {
  resolve: (frame: BulkAckFrame) => void;
  reject: (error: Error) => void;
}

export interface BulkSenderOpenOptions {
  transferId?: Uint8Array<ArrayBuffer>;
  totalSize?: number;
  contentType?: string;
  targetDevice?: DeviceId;
  token?: CapabilityToken;
  timeoutMs?: number;
}

export interface BulkSender {
  /** Observes bulk-ack frames for transfers this sender currently owns. Wire as (part of) the onFrame passed to acceptMeshSession/createSessionCore, alongside anything else already observing the same connection. */
  onFrame: (connection: Readonly<Connection>, frame: Frame) => void;
  /** Opens a brand-new transfer and streams it from seq 0 until the source is exhausted (returns "complete") or this connection ends (returns "incomplete", i.e. a caller with a fresh connection may retry via continueFrom once the receiver's own bulk.resume arrives). */
  open: (
    connection: Readonly<Connection>,
    session: Readonly<MeshSession>,
    scope: Readonly<CapabilityScope>,
    options?: Readonly<BulkSenderOpenOptions>,
  ) => Promise<BulkSendOutcome>;
  /** Resumes an already-open transfer on a fresh connection, streaming from wherever the receiver's own post-accept bulk-ack says to (its ack-seq, a count of chunks already durably persisted) with no bulk.open sent again -- the receiver already confirmed via a prior bulk.resume that it wants this. */
  continueFrom: (
    connection: Readonly<Connection>,
    transferId: Uint8Array<ArrayBuffer>,
  ) => Promise<BulkSendOutcome>;
  /** Builds a manage-request handler for incoming bulk.resume asks, bound to one connection (wire as this session's own bulk:read-scoped handler). Refuses a request naming any transfer other than the one this sender currently has open. onResumed, if given, is called with the resulting BulkSendOutcome once the resumed stream settles -- the handler itself does not await it, so a caller not needing to observe it may omit onResumed entirely without leaking an unhandled rejection (errors inside stream() are already caught and folded into an "incomplete" outcome, never thrown). */
  createResumeHandler: (
    connection: Readonly<Connection>,
    onResumed?: (outcome: Readonly<BulkSendOutcome>) => void,
  ) => (incoming: Readonly<IncomingManageRequest>) => Promise<void>;
  /** Builds a manage-request handler for incoming bulk.cancel asks (wire as this session's own bulk:write-scoped handler). Marks the named transfer cancelled so the next iteration of an in-progress stream() loop stops rather than sending further chunks -- a currently-blocked wait for an ack is not itself interrupted, since nothing here has a way to abort an in-flight Promise, only to stop starting new work once it resolves. */
  createCancelHandler: () => (
    incoming: Readonly<IncomingManageRequest>,
  ) => Promise<void>;
  /** Tells this sender that a connection it was streaming over has ended (its own receive() stream reached done:true) -- without this, an in-progress stream() call blocked waiting for the next ack would hang forever rather than settling as "incomplete", since nothing else here observes connection lifecycle (open()/continueFrom() only ever learn about the connection through frames arriving on it). A caller's own pump/onFrame loop should call this once its receive() iteration ends, mirroring the onSessionEnd hook acceptMeshSession already exposes for the identical reason. */
  onConnectionEnd: (connection: Readonly<Connection>) => void;
}

/**
 * Builds a sender coordinator over one `source`. A caller sending several independent transfers from different sources constructs one sender per source, mirroring createCapabilityRequestHandler's own one-instance-per-capability convention.
 */
export function createBulkSender(
  options: Readonly<CreateBulkSenderOptions>,
): BulkSender {
  const pendingAcks = new Map<string, PendingAck[]>();
  const cancelled = new Set<string>();

  function resolveNextAck(id: string, frame: BulkAckFrame): void {
    const queue = pendingAcks.get(id);
    if (queue === undefined || queue.length === 0) return;
    const waiter = queue.shift();
    waiter?.resolve(frame);
  }

  function rejectAllAcks(id: string, error: Error): void {
    const queue = pendingAcks.get(id);
    if (queue === undefined) return;
    pendingAcks.set(id, []);
    for (const waiter of queue) waiter.reject(error);
  }

  async function waitForAck(id: string): Promise<BulkAckFrame> {
    return new Promise((resolve, reject) => {
      const queue = pendingAcks.get(id) ?? [];
      queue.push({ resolve, reject });
      pendingAcks.set(id, queue);
    });
  }

  async function stream(
    connection: Readonly<Connection>,
    transferId: Uint8Array<ArrayBuffer>,
    fromSeq: number,
    initialWindow: number,
  ): Promise<BulkSendOutcome> {
    const id = transferIdHex(transferId);
    let seq = fromSeq;
    let ackedCount = fromSeq;
    let window = initialWindow;
    let bytesInFlight = 0;
    // Chunks sent but not yet covered by the receiver's own ack-seq -- needed because window is a byte credit while ack-seq is a chunk count, so "how many bytes are currently outstanding" can only be derived by tracking each unacked chunk's own length.
    const inFlight: { seq: number; length: number }[] = [];

    try {
      for await (const chunk of options.source(fromSeq)) {
        if (cancelled.has(id)) {
          return { status: "incomplete", ackedCount };
        }
        while (bytesInFlight + chunk.length > window) {
          const ack = await waitForAck(id);
          ackedCount = ack["ack-seq"];
          window = ack.window;
          for (;;) {
            const head = inFlight[0];
            // A chunk with seq s is covered once ackedCount > s (ack-seq counts persisted chunks, so ackedCount chunks 0..ackedCount-1 are durable).
            if (head === undefined || head.seq >= ackedCount) break;
            inFlight.shift();
            bytesInFlight -= head.length;
          }
        }
        const dataFrame: BulkDataFrame = {
          type: "bulk-data",
          "transfer-id": transferId,
          seq,
          bytes: chunk,
        };
        await connection.send(dataFrame);
        inFlight.push({ seq, length: chunk.length });
        bytesInFlight += chunk.length;
        seq += 1;
      }
    } catch {
      return { status: "incomplete", ackedCount };
    }

    // Re-reads the source from the very start (never just this call's own fromSeq..end range, since a resumed stream would otherwise hash only its own tail) to compute the full-content digest -- the same re-readability contract resumption already depends on, reused here so the streaming loop above never has to buffer the whole transfer.
    const chunks: Uint8Array[] = [];
    for await (const chunk of options.source(0)) {
      chunks.push(chunk);
    }
    const digest = await digestOf(concatChunks(chunks));
    const endFrame: BulkEndFrame = {
      type: "bulk-end",
      "transfer-id": transferId,
      digest,
    };
    await connection.send(endFrame);
    return { status: "complete", ackedCount: seq };
  }

  /** Waits for the receiver's own post-accept bulk-ack -- ack-seq is a count of chunks durably persisted so far, so it doubles as the seq to resume streaming from with no adjustment -- and starts streaming from there. Shared by open() (after bulk.open is accepted, where the very first ack's own ack-seq is naturally 0 for a fresh transfer) and continueFrom() (after a bulk.resume is accepted), since a receiver sends this identical proactive ack in both cases per spec/bulk.cddl's own bulk-ack-frame comment. */
  async function resumeStream(
    connection: Readonly<Connection>,
    transferId: Uint8Array<ArrayBuffer>,
  ): Promise<BulkSendOutcome> {
    const ack = await waitForAck(transferIdHex(transferId));
    return stream(connection, transferId, ack["ack-seq"], ack.window);
  }

  let activeTransferId: string | undefined;
  let activeConnection: Readonly<Connection> | undefined;

  return {
    onFrame(_connection, frame) {
      if (frame.type !== "bulk-ack") return;
      resolveNextAck(transferIdHex(frame["transfer-id"]), frame);
    },
    onConnectionEnd(connection) {
      if (activeTransferId === undefined || activeConnection !== connection) {
        return;
      }
      rejectAllAcks(activeTransferId, new Error("connection ended"));
    },
    createCancelHandler() {
      return async function handleBulkCancel(
        incoming: Readonly<IncomingManageRequest>,
      ): Promise<void> {
        const parsed = bulkCancelSchema.safeParse(incoming.command.params);
        if (!parsed.success) {
          await incoming.respond({ result: "error", code: "malformed" });
          return;
        }
        cancelled.add(transferIdHex(parsed.data["transfer-id"]));
        await incoming.respond({ result: "ok" });
      };
    },
    async open(connection, session, scope, openOptions = {}) {
      const transferId = openOptions.transferId ?? randomTransferId();
      activeTransferId = transferIdHex(transferId);
      activeConnection = connection;
      const outcome = await session.sendManageRequest(
        buildBulkOpenCommand(transferId, {
          ...(openOptions.totalSize !== undefined
            ? { totalSize: openOptions.totalSize }
            : {}),
          ...(openOptions.contentType !== undefined
            ? { contentType: openOptions.contentType }
            : {}),
        }),
        scope,
        openOptions.targetDevice,
        openOptions.token,
        openOptions.timeoutMs,
      );
      if (outcome.result !== "ok") {
        return {
          status: "rejected",
          ackedCount: 0,
          code: outcome.code,
        };
      }
      return resumeStream(connection, transferId);
    },
    async continueFrom(connection, transferId) {
      activeTransferId = transferIdHex(transferId);
      activeConnection = connection;
      return resumeStream(connection, transferId);
    },
    createResumeHandler(connection, onResumed) {
      return async function handleBulkResume(
        incoming: Readonly<IncomingManageRequest>,
      ): Promise<void> {
        const parsed = bulkResumeSchema.safeParse(incoming.command.params);
        if (!parsed.success) {
          await incoming.respond({ result: "error", code: "malformed" });
          return;
        }
        const { "transfer-id": transferId } = parsed.data;
        if (transferIdHex(transferId) !== activeTransferId) {
          await incoming.respond({
            result: "error",
            code: "unknown_transfer",
          });
          return;
        }
        await incoming.respond({ result: "ok" });
        activeConnection = connection;
        resumeStream(connection, transferId)
          .then((outcome) => onResumed?.(outcome))
          .catch(() => undefined);
      };
    },
  };
}

// ---------------------------------------------------------------------
// Receiver
// ---------------------------------------------------------------------

function openerKey(idHex: string): string {
  return `bulk/${idHex}/opener`;
}
function ackSeqKey(idHex: string): string {
  return `bulk/${idHex}/ack-seq`;
}
function windowKey(idHex: string): string {
  return `bulk/${idHex}/window`;
}
function chunkKey(idHex: string, seq: number): string {
  return `bulk/${idHex}/chunk/${String(seq)}`;
}

function encodeUint(n: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(String(n));
}
function decodeUint(bytes: Uint8Array): number {
  return Number(new TextDecoder().decode(bytes));
}

export interface BulkReceiveResult {
  ok: boolean;
  /** Count of chunks durably persisted for this transfer once bulk-end arrived -- meaningful even when ok is false (digest mismatch), since the chunks themselves are still exactly what was received. */
  chunkCount: number;
}

export type BulkOfferDecision =
  | {
      kind: "accept";
      /** Initial credit window, in bytes, this receiver is willing to accept past its own ack-seq -- a resource-limit choice for the caller to make (per spec/bulk.cddl's own "receiver resource limits are deployment policy, not protocol" design point), not a value this module invents a default for. */
      window: number;
      /** Called once, when bulk-end arrives and the digest has been checked against every durably-persisted chunk -- the only signal a caller gets that this transfer finished (successfully or corrupt), since createOpenHandler's own handler returns long before that. */
      onComplete?: (result: Readonly<BulkReceiveResult>) => void;
    }
  | { kind: "reject"; reason?: string };

export interface BulkOfferEvent {
  transferId: Uint8Array<ArrayBuffer>;
  totalSize?: number;
  contentType?: string;
  /** The peer device-id authenticated on the connection this bulk.open arrived over -- supplied by the caller (createOpenHandler's own parameter), the same "MeshSession exposes no way to learn this independently" reason capability-request.ts's own bearerDevice parameter exists. */
  openerDevice: DeviceId;
  decide: (decision: Readonly<BulkOfferDecision>) => Promise<void>;
}

interface Registration {
  openerDevice: DeviceId;
  connection: Readonly<Connection>;
  onComplete?: (result: Readonly<BulkReceiveResult>) => void;
}

export interface BulkReceiver {
  /** Handles bulk-data/bulk-end frames for transfers this receiver has accepted, durably persisting each contiguous chunk and acking before advertising it (spec/bulk.cddl's own obligation 1). Ignores a frame naming a transfer this receiver hasn't accepted, or arriving on a connection other than the one currently registered for it (an old, since-superseded connection racing a fresh bulk.resume). Wire as (part of) the onFrame passed to acceptMeshSession, alongside anything else observing the same connection. */
  onFrame: (connection: Readonly<Connection>, frame: Frame) => Promise<void>;
  /** Builds a manage-request handler for incoming bulk.open asks, bound to one connection and its already-authenticated peer device-id (mirroring createCapabilityRequestHandler's own per-connection factory shape). Refuses a transfer-id already known to this receiver as "already_exists" -- resuming an existing transfer is requestResume's job, not a second bulk.open. */
  createOpenHandler: (
    openerDevice: DeviceId,
    connection: Readonly<Connection>,
    onOffer: (event: Readonly<BulkOfferEvent>) => void,
  ) => (incoming: Readonly<IncomingManageRequest>) => Promise<void>;
  /** Actively sends bulk.resume on a fresh connection for an already-accepted transfer, reading this receiver's own durably-persisted ack-seq as the resume point (spec/bulk.cddl's own "resumption is receiver-driven" design point) -- there is no separate bulk.open to send again. On success, re-associates the transfer with this connection so onFrame accepts its subsequent bulk-data/bulk-end frames. */
  requestResume: (
    connection: Readonly<Connection>,
    session: Readonly<MeshSession>,
    transferId: Uint8Array<ArrayBuffer>,
    scope: Readonly<CapabilityScope>,
    targetDevice?: DeviceId,
    token?: CapabilityToken,
    timeoutMs?: number,
  ) => Promise<{ status: "ok" | "rejected"; code?: string }>;
  /** Builds a manage-request handler for incoming bulk.cancel asks (wire as this session's own bulk:read-scoped handler, mirroring the sender's own bulk:write-scoped one) -- deregisters the transfer's connection association so a stray already-in-flight bulk-data/bulk-end for it is ignored by onFrame from then on. Durably-persisted chunks are left in storage rather than purged: a cancelled transfer is not proof the caller has lost interest in what was already received, only that no more is coming, and purging is the caller's own decision to make with the KeyValueStorage it supplied. */
  createCancelHandler: () => (
    incoming: Readonly<IncomingManageRequest>,
  ) => Promise<void>;
}

export interface CreateBulkReceiverOptions {
  storage: KeyValueStorage;
}

/**
 * Builds a receiver coordinator over one KeyValueStorage. Constructed once and shared across every connection this side accepts -- durable per-transfer state (which chunks are persisted, who opened it) and the in-memory registry of which connection currently owns each transfer must both outlive any one connection for resumption to mean anything at all.
 */
export function createBulkReceiver(
  options: Readonly<CreateBulkReceiverOptions>,
): BulkReceiver {
  const { storage } = options;
  const registrations = new Map<string, Registration>();

  async function readAckSeq(idHex: string): Promise<number> {
    const bytes = await storage.get(ackSeqKey(idHex));
    return bytes === undefined ? 0 : decodeUint(bytes);
  }

  return {
    async onFrame(connection, frame) {
      if (frame.type !== "bulk-data" && frame.type !== "bulk-end") return;
      const idHex = transferIdHex(frame["transfer-id"]);
      const reg = registrations.get(idHex);
      if (reg?.connection !== connection) return;

      if (frame.type === "bulk-data") {
        const ackedCount = await readAckSeq(idHex);
        if (frame.seq !== ackedCount) return; // non-contiguous: dropped, per this receiver's own first-pass simplification (see bulk.ts's own header comment)
        await storage.set(chunkKey(idHex, frame.seq), frame.bytes);
        const newAckedCount = ackedCount + 1;
        await storage.set(ackSeqKey(idHex), encodeUint(newAckedCount));
        const windowBytes = await storage.get(windowKey(idHex));
        const window = windowBytes === undefined ? 0 : decodeUint(windowBytes);
        const ackFrame: BulkAckFrame = {
          type: "bulk-ack",
          "transfer-id": frame["transfer-id"],
          "ack-seq": newAckedCount,
          window,
        };
        await connection.send(ackFrame);
        return;
      }

      // bulk-end: verify the claimed digest against every durably-persisted chunk before treating the transfer as genuinely complete (spec/bulk.cddl's own obligation 3).
      const ackedCount = await readAckSeq(idHex);
      const chunks: Uint8Array[] = [];
      for (let seq = 0; seq < ackedCount; seq += 1) {
        const chunk = await storage.get(chunkKey(idHex, seq));
        if (chunk !== undefined) chunks.push(chunk);
      }
      const digest = await digestOf(concatChunks(chunks));
      const ok = bytesEqual(digest, frame.digest);
      reg.onComplete?.({ ok, chunkCount: ackedCount });
    },
    createOpenHandler(openerDevice, connection, onOffer) {
      return async function handleBulkOpen(
        incoming: Readonly<IncomingManageRequest>,
      ): Promise<void> {
        const parsed = bulkOpenSchema.safeParse(incoming.command.params);
        if (!parsed.success) {
          await incoming.respond({ result: "error", code: "malformed" });
          return;
        }
        const { "transfer-id": transferId } = parsed.data;
        const idHex = transferIdHex(transferId);
        const existingOpener = await storage.get(openerKey(idHex));
        if (existingOpener !== undefined) {
          await incoming.respond({ result: "error", code: "already_exists" });
          return;
        }

        onOffer({
          transferId,
          ...(parsed.data["total-size"] !== undefined
            ? { totalSize: parsed.data["total-size"] }
            : {}),
          ...(parsed.data["content-type"] !== undefined
            ? { contentType: parsed.data["content-type"] }
            : {}),
          openerDevice,
          async decide(decision) {
            if (decision.kind === "reject") {
              await incoming.respond({
                result: "error",
                code: "denied",
                ...(decision.reason !== undefined
                  ? { message: decision.reason }
                  : {}),
              });
              return;
            }
            await storage.set(openerKey(idHex), openerDevice);
            await storage.set(ackSeqKey(idHex), encodeUint(0));
            await storage.set(windowKey(idHex), encodeUint(decision.window));
            registrations.set(idHex, {
              openerDevice,
              connection,
              ...(decision.onComplete !== undefined
                ? { onComplete: decision.onComplete }
                : {}),
            });
            await incoming.respond({ result: "ok" });
            const ackFrame: BulkAckFrame = {
              type: "bulk-ack",
              "transfer-id": transferId,
              "ack-seq": 0,
              window: decision.window,
            };
            await connection.send(ackFrame);
          },
        });
      };
    },
    async requestResume(
      connection,
      session,
      transferId,
      scope,
      targetDevice,
      token,
      timeoutMs,
    ) {
      const idHex = transferIdHex(transferId);
      const existing = registrations.get(idHex);
      const storedOpener = await storage.get(openerKey(idHex));
      // Re-boxed into a fresh Uint8Array: KeyValueStorage's own port contract leaves the backing buffer kind unpinned (ArrayBufferLike), while a stored device-id must satisfy DeviceId's stricter Uint8Array<ArrayBuffer> shape.
      const openerDevice =
        existing?.openerDevice ??
        (storedOpener === undefined ? undefined : new Uint8Array(storedOpener));
      if (openerDevice === undefined) {
        // Nothing this receiver ever accepted a bulk.open for -- resuming a transfer it never opened is a caller error, not something to silently proceed on with a fabricated opener identity.
        return { status: "rejected", code: "unknown_transfer" };
      }
      const ackedCount = await readAckSeq(idHex);
      const outcome = await session.sendManageRequest(
        buildBulkResumeCommand(transferId, ackedCount),
        scope,
        targetDevice,
        token,
        timeoutMs,
      );
      if (outcome.result !== "ok") {
        return { status: "rejected", code: outcome.code };
      }
      registrations.set(idHex, {
        openerDevice,
        connection,
        ...(existing?.onComplete !== undefined
          ? { onComplete: existing.onComplete }
          : {}),
      });
      // Proactively re-advertises this receiver's own current ack-seq/window on the fresh connection, the same obligation createOpenHandler's own accept path already fulfils for a brand-new transfer (spec/bulk.cddl's own bulk-ack-frame comment covers both cases identically) -- without this, the sender's own resumeStream has nothing to wait for and would hang indefinitely.
      const windowBytes = await storage.get(windowKey(idHex));
      const window = windowBytes === undefined ? 0 : decodeUint(windowBytes);
      const ackFrame: BulkAckFrame = {
        type: "bulk-ack",
        "transfer-id": transferId,
        "ack-seq": ackedCount,
        window,
      };
      await connection.send(ackFrame);
      return { status: "ok" };
    },
    createCancelHandler() {
      return async function handleBulkCancel(
        incoming: Readonly<IncomingManageRequest>,
      ): Promise<void> {
        const parsed = bulkCancelSchema.safeParse(incoming.command.params);
        if (!parsed.success) {
          await incoming.respond({ result: "error", code: "malformed" });
          return;
        }
        registrations.delete(transferIdHex(parsed.data["transfer-id"]));
        await incoming.respond({ result: "ok" });
      };
    },
  };
}
