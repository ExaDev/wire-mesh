import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { formatPinnedAddress } from "wire-mesh-core/domain/pinned-address";
import { createCertificateMemory } from "../src/certificate-memory.js";
import {
  STREAM_OPEN_TIMEOUT_MS,
  createBrowserWebTransportTransport,
} from "../src/adapters/webtransport-transport.js";

const HASH_BYTES = 32;
const HASH_HEX = "ab".repeat(HASH_BYTES);
const ADDRESS = formatPinnedAddress("192.0.2.5:4433", [HASH_HEX]);

/** A session that is ready but whose streams never open, as Safari's do against a node that grants no flow-control credit. */
class StuckSession {
  static closed = 0;

  readonly ready = Promise.resolve();

  readonly closed = new Promise<never>(() => undefined);

  readonly incomingUnidirectionalStreams = new ReadableStream();

  readonly createBidirectionalStream = async (): Promise<never> =>
    new Promise<never>(() => undefined);

  close(): void {
    StuckSession.closed += 1;
  }
}

describe("createBrowserWebTransportTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    StuckSession.closed = 0;
  });

  it("closes the session and says why when the browser cannot open a stream", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebTransport", StuckSession);
    const transport = createBrowserWebTransportTransport(
      createCertificateMemory(createMemoryStorage()),
    );
    const connecting = transport.connect(ADDRESS);
    const refused = expect(connecting).rejects.toThrow("cannot open a stream");
    await vi.advanceTimersByTimeAsync(STREAM_OPEN_TIMEOUT_MS);
    await refused;
    expect(StuckSession.closed).toBe(1);
  });
});
