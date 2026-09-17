import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import {
  createShardCollector,
  createShardHolder,
  distributeShardedPayload,
  locateShardManifests,
  type ShardChannel,
} from "../src/domain/sharded-delivery.js";
import type { BulkOfferEvent, BulkReceiveResult } from "../src/domain/bulk.js";
import {
  decryptNoticeContent,
  encryptNoticeContent,
  generateContentKey,
} from "../src/domain/group-key.js";
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
import type { IdentityPort } from "../src/ports/identity.js";
import { deviceIdFromFillHex } from "./hex.js";

const TEST_SCOPE: CapabilityScope = { kind: "folder", path: "/shards" };
const K2_N3 = { dataShards: 2, totalShards: 3 };
const TRANSFER_ID_BYTE_LENGTH = 16;
const MISMATCHED_TRANSFER_ID_BYTE = 99;

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function identityFor(fillHex: string): IdentityPort {
  const deviceId = deviceIdFromFillHex(fillHex);
  return {
    deviceId,
    identityKey: { alg: -7, "public-key": new Uint8Array() },
    sign: async () => Promise.resolve(new Uint8Array()),
    verify: async () => Promise.resolve(true),
    deriveDeviceId: async () => Promise.resolve(deviceId),
  };
}

/** A one-directional, wake-on-push frame queue, mirroring bulk.unit.test.ts's own FakeInbound -- kept file-local rather than shared, matching that file's own convention of not factoring these fixtures out further. */
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

/** Two Connections wired directly to each other, mirroring bulk.unit.test.ts's own linkedConnections. */
function linkedConnections(): {
  senderConn: Readonly<Connection>;
  receiverConn: Readonly<Connection>;
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
  return { senderConn, receiverConn };
}

/** Wraps a manage-request handler as a MeshSession.sendManageRequest, mirroring bulk.unit.test.ts's own sessionDispatchingTo. */
function sessionDispatchingTo(
  handler: (incoming: IncomingManageRequest) => Promise<void>,
): MeshSession {
  return {
    async sendManageRequest(
      command: ManageCommand,
      scope: Readonly<CapabilityScope>,
    ): Promise<ManageOutcome> {
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A holder half-wired for one incoming shard offer: links a fresh connection pair, arms the holder's own createOpenHandler to accept unconditionally, and returns the sender-side channel a distributor pushes over plus a promise settling once the holder durably finished receiving. */
function holderAcceptingChannel(
  holder: Readonly<ReturnType<typeof createShardHolder>>,
  senderDevice: DeviceId,
): { channel: ShardChannel; accepted: Promise<BulkReceiveResult> } {
  const { senderConn, receiverConn } = linkedConnections();
  const accepted = deferred<BulkReceiveResult>();
  const openHandler = holder.createOpenHandler(
    senderDevice,
    receiverConn,
    (event: Readonly<BulkOfferEvent>) => {
      void event.decide({
        kind: "accept",
        window: event.totalSize ?? Number.MAX_SAFE_INTEGER,
        onComplete: accepted.resolve,
      });
    },
  );
  const session = sessionDispatchingTo(openHandler);
  void (async () => {
    for await (const frame of receiverConn.receive()) {
      await holder.onFrame(receiverConn, frame);
    }
  })();
  return {
    channel: { connection: senderConn, session },
    accepted: accepted.promise,
  };
}

/** A fresh connection pair a holder can serveShard() over to a reader's own collector, wired symmetrically to holderAcceptingChannel above. */
function readerChannel(
  collector: ReturnType<typeof createShardCollector>,
  holderDevice: DeviceId,
  index: number,
): { holderChannel: ShardChannel } {
  const { senderConn, receiverConn } = linkedConnections();
  const openHandler = collector.receiver.createOpenHandler(
    holderDevice,
    receiverConn,
    collector.onOfferForIndex(index),
  );
  void (async () => {
    for await (const frame of receiverConn.receive()) {
      await collector.receiver.onFrame(receiverConn, frame);
    }
  })();
  const session = sessionDispatchingTo(openHandler);
  return { holderChannel: { connection: senderConn, session } };
}

describe("distributeShardedPayload", () => {
  it("pushes every shard to its target holder and publishes the manifest to the sender's own log", async () => {
    const senderIdentity = identityFor("aa");
    const senderStorage = createMemoryStorage();
    const holderA = createShardHolder({ storage: createMemoryStorage() });
    const holderB = createShardHolder({ storage: createMemoryStorage() });
    const holderC = createShardHolder({ storage: createMemoryStorage() });
    const deviceHolderA = deviceIdFromFillHex("01");
    const deviceHolderB = deviceIdFromFillHex("02");
    const deviceHolderC = deviceIdFromFillHex("03");

    const linkA = holderAcceptingChannel(holderA, senderIdentity.deviceId);
    const linkB = holderAcceptingChannel(holderB, senderIdentity.deviceId);
    const linkC = holderAcceptingChannel(holderC, senderIdentity.deviceId);

    const payload = text("the quick brown fox jumps over the lazy dog");
    const distributed = await distributeShardedPayload(payload, {
      config: K2_N3,
      contentType: "text/plain",
      targets: [deviceHolderA, deviceHolderB, deviceHolderC],
      channels: [linkA.channel, linkB.channel, linkC.channel],
      nextTransferId: (i) => {
        const id = new Uint8Array(TRANSFER_ID_BYTE_LENGTH);
        id.fill(i + 1);
        return id;
      },
      scope: TEST_SCOPE,
      identity: senderIdentity,
      storage: senderStorage,
    });

    expect(distributed.outcomes.every((o) => o.status === "complete")).toBe(
      true,
    );
    expect(distributed.manifest["total-shards"]).toBe(K2_N3.totalShards);
    expect(distributed.manifest.threshold).toBe(K2_N3.dataShards);
    expect(distributed.manifest.shards.map((s) => s.device)).toEqual([
      deviceHolderA,
      deviceHolderB,
      deviceHolderC,
    ]);

    const acceptedA = await linkA.accepted;
    const acceptedB = await linkB.accepted;
    const acceptedC = await linkC.accepted;
    expect(acceptedA.ok).toBe(true);
    expect(acceptedB.ok).toBe(true);
    expect(acceptedC.ok).toBe(true);

    const manifests = await locateShardManifests({
      storage: senderStorage,
      publisher: senderIdentity.deviceId,
    });
    expect(manifests).toEqual([distributed.manifest]);
  });

  it("rejects when there are fewer channels than shards", async () => {
    const senderIdentity = identityFor("aa");
    const holder = createShardHolder({ storage: createMemoryStorage() });
    const link = holderAcceptingChannel(holder, senderIdentity.deviceId);
    await expect(
      distributeShardedPayload(text("short"), {
        config: K2_N3,
        contentType: "text/plain",
        targets: [deviceIdFromFillHex("01")],
        channels: [link.channel],
        nextTransferId: () => new Uint8Array(TRANSFER_ID_BYTE_LENGTH),
        scope: TEST_SCOPE,
        identity: senderIdentity,
        storage: createMemoryStorage(),
      }),
    ).rejects.toThrow(/channel/);
  });
});

describe("end-to-end sharded delivery: distribute, hold, serve, collect, reconstruct", () => {
  it("reconstructs the original payload from any threshold of the distributed shards, having never touched a full N", async () => {
    const senderIdentity = identityFor("aa");
    const senderStorage = createMemoryStorage();
    const holderA = createShardHolder({ storage: createMemoryStorage() });
    const holderB = createShardHolder({ storage: createMemoryStorage() });
    const holderC = createShardHolder({ storage: createMemoryStorage() });
    const deviceHolderA = deviceIdFromFillHex("01");
    const deviceHolderB = deviceIdFromFillHex("02");
    const deviceHolderC = deviceIdFromFillHex("03");
    const holderDevices = [deviceHolderA, deviceHolderB, deviceHolderC];

    const linkA = holderAcceptingChannel(holderA, senderIdentity.deviceId);
    const linkB = holderAcceptingChannel(holderB, senderIdentity.deviceId);
    const linkC = holderAcceptingChannel(holderC, senderIdentity.deviceId);
    const distributionLinks = [linkA, linkB, linkC];

    const payload = text(
      "this payload survives losing any one of three holders",
    );
    const distributed = await distributeShardedPayload(payload, {
      config: K2_N3,
      contentType: "text/plain",
      targets: holderDevices,
      channels: distributionLinks.map((l) => l.channel),
      nextTransferId: (i) => {
        const id = new Uint8Array(TRANSFER_ID_BYTE_LENGTH);
        id.fill(i + 1);
        return id;
      },
      scope: TEST_SCOPE,
      identity: senderIdentity,
      storage: senderStorage,
    });
    await Promise.all(distributionLinks.map(async (l) => l.accepted));

    // A reader collects from only holders A and B -- holder C (a third, distinct holder device, per #161's own "a two-party DM is not the shape this addresses") is never even contacted, proving reconstruction genuinely needs only `threshold`, not `total-shards`.
    const readerStorage = createMemoryStorage();
    const collector = createShardCollector({
      manifest: distributed.manifest,
      storage: readerStorage,
    });
    const readerLinkA = readerChannel(collector, deviceHolderA, 0);
    const readerLinkB = readerChannel(collector, deviceHolderB, 1);

    const locationA = distributed.manifest.shards[0];
    const locationB = distributed.manifest.shards[1];
    if (locationA === undefined || locationB === undefined) {
      throw new Error("test setup: manifest missing shard locations");
    }
    const readerDevice = deviceIdFromFillHex("99");
    await holderA.serveShard(
      readerLinkA.holderChannel,
      locationA["transfer-id"],
      readerDevice,
      TEST_SCOPE,
    );
    await holderB.serveShard(
      readerLinkB.holderChannel,
      locationB["transfer-id"],
      readerDevice,
      TEST_SCOPE,
    );

    const reconstructed = await collector.result;
    expect(reconstructed).toEqual(payload);
  });

  it("decrypts the reconstructed payload with the epoch key, when the sharded content was encrypted", async () => {
    const senderIdentity = identityFor("bb");
    const senderStorage = createMemoryStorage();
    const holderA = createShardHolder({ storage: createMemoryStorage() });
    const holderB = createShardHolder({ storage: createMemoryStorage() });
    const deviceHolderA = deviceIdFromFillHex("11");
    const deviceHolderB = deviceIdFromFillHex("12");
    const holderDevices = [deviceHolderA, deviceHolderB];
    const linkA = holderAcceptingChannel(holderA, senderIdentity.deviceId);
    const linkB = holderAcceptingChannel(holderB, senderIdentity.deviceId);
    const distributionLinks = [linkA, linkB];

    const epochKey = generateContentKey();
    const plaintext = text("a secret only the epoch key can recover");
    const ciphertext = await encryptNoticeContent(epochKey, plaintext);

    const distributed = await distributeShardedPayload(ciphertext, {
      config: { dataShards: 2, totalShards: 2 },
      contentType: "text/plain+aes256gcm",
      targets: holderDevices,
      channels: distributionLinks.map((l) => l.channel),
      nextTransferId: (i) => {
        const id = new Uint8Array(TRANSFER_ID_BYTE_LENGTH);
        id.fill(i + 1);
        return id;
      },
      scope: TEST_SCOPE,
      identity: senderIdentity,
      storage: senderStorage,
    });
    await Promise.all(distributionLinks.map(async (l) => l.accepted));

    const readerStorage = createMemoryStorage();
    const collector = createShardCollector({
      manifest: distributed.manifest,
      storage: readerStorage,
      decrypt: async (data) => decryptNoticeContent(epochKey, data),
    });
    const readerLinkA = readerChannel(collector, deviceHolderA, 0);
    const readerLinkB = readerChannel(collector, deviceHolderB, 1);
    const locationA = distributed.manifest.shards[0];
    const locationB = distributed.manifest.shards[1];
    if (locationA === undefined || locationB === undefined) {
      throw new Error("test setup: manifest missing shard locations");
    }
    const readerDevice = deviceIdFromFillHex("98");
    await holderA.serveShard(
      readerLinkA.holderChannel,
      locationA["transfer-id"],
      readerDevice,
      TEST_SCOPE,
    );
    await holderB.serveShard(
      readerLinkB.holderChannel,
      locationB["transfer-id"],
      readerDevice,
      TEST_SCOPE,
    );

    const recovered = await collector.result;
    expect(recovered).toEqual(plaintext);
  });

  it("refuses a shard offer whose transfer-id does not match the manifest's own entry for that index", async () => {
    const manifest = {
      "total-shards": 2,
      threshold: 2,
      "content-type": "text/plain",
      "original-length": 4,
      shards: [
        {
          device: deviceIdFromFillHex("01"),
          "transfer-id": Uint8Array.from([1]),
        },
        {
          device: deviceIdFromFillHex("02"),
          "transfer-id": Uint8Array.from([2]),
        },
      ],
    };
    const collector = createShardCollector({
      manifest,
      storage: createMemoryStorage(),
    });
    let decision: string | undefined;
    const wrongOffer: BulkOfferEvent = {
      transferId: Uint8Array.from([MISMATCHED_TRANSFER_ID_BYTE]),
      openerDevice: deviceIdFromFillHex("01"),
      decide: async (d) => {
        decision = d.kind;
        return Promise.resolve();
      },
    };
    collector.onOfferForIndex(0)(wrongOffer);
    await Promise.resolve();
    expect(decision).toBe("reject");
  });
});

describe("locateShardManifests", () => {
  it("returns an empty array for a publisher with no log entries at all", async () => {
    const manifests = await locateShardManifests({
      storage: createMemoryStorage(),
      publisher: deviceIdFromFillHex("01"),
    });
    expect(manifests).toEqual([]);
  });
});
