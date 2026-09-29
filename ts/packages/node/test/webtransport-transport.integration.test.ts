import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePinnedAddress } from "wire-mesh-core/domain/pinned-address";
import { ADVERTISED_CERTIFICATES } from "../src/adapters/certificate-schedule.js";
import {
  createWebTransportTransport,
  type WebTransportListener,
} from "../src/adapters/webtransport-transport.js";
import {
  MAX_PINNED_CERTIFICATE_LIFETIME_MS,
  PINNED_CERTIFICATE_LIFETIME_MS,
} from "../src/adapters/certificate-limits.js";
import { mintPinnedCertificate } from "../src/adapters/pinned-certificate.js";

const LOOPBACK_ANY_PORT = "127.0.0.1:0";
const SHA256_HEX_LENGTH = 64;
const TEST_TIMEOUT_MS = 30_000;
/** Short enough that the first rotation, half of it away, arrives within the test. */
const SHORT_LIFETIME_MS = 2000;
let rotatedResolve: (addresses: readonly string[]) => void = () => undefined;

describe("mintPinnedCertificate", () => {
  it("mints a certificate a browser accepts by hash: under two weeks, hash of the DER", async () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const minted = await mintPinnedCertificate(now);
    expect(minted.sha256Hex).toHaveLength(SHA256_HEX_LENGTH);
    expect(minted.notAfter.getTime() - now.getTime()).toBe(
      PINNED_CERTIFICATE_LIFETIME_MS,
    );
    expect(PINNED_CERTIFICATE_LIFETIME_MS).toBeLessThan(
      MAX_PINNED_CERTIFICATE_LIFETIME_MS,
    );
    expect(minted.certificatePem).toContain("BEGIN CERTIFICATE");
    expect(minted.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });
});

describe("createWebTransportTransport", () => {
  let listener: WebTransportListener | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await listener?.close();
    listener = undefined;
  });

  it(
    "serves on a bound port and advertises its address with the hash of the certificate it serves",
    async () => {
      listener = await createWebTransportTransport().listen(
        LOOPBACK_ANY_PORT,
        () => undefined,
      );
      const [address] = listener.advertisedAddresses;
      expect(address).toBeDefined();
      const advertised = parsePinnedAddress(address ?? "");
      expect(advertised.url).toBe(`https://${listener.address}/`);
      expect(advertised.sha256).toHaveLength(ADVERTISED_CERTIFICATES);
      for (const hash of advertised.sha256) {
        expect(hash).toHaveLength(SHA256_HEX_LENGTH / 2);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "advertises a reachable address for each interface when bound to a wildcard",
    async () => {
      listener = await createWebTransportTransport().listen(
        "0.0.0.0:0",
        () => undefined,
      );
      expect(listener.advertisedAddresses.length).toBeGreaterThan(0);
      for (const address of listener.advertisedAddresses) {
        expect(address).not.toContain("0.0.0.0");
        expect(() => parsePinnedAddress(address)).not.toThrow();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rotates to the next certificate on schedule, on the same port, listing the hash that takes over",
    async () => {
      const rotated = new Promise<readonly string[]>((resolve) => {
        rotatedResolve = resolve;
      });
      listener = await createWebTransportTransport({
        certificateLifetimeMs: SHORT_LIFETIME_MS,
        onCertificateRenewed: (addresses) => {
          rotatedResolve(addresses);
        },
      }).listen(LOOPBACK_ANY_PORT, () => undefined);
      const [beforeAddress] = listener.advertisedAddresses;
      const before = parsePinnedAddress(beforeAddress ?? "");
      const port = listener.address;
      const [afterAddress] = await rotated;
      const after = parsePinnedAddress(afterAddress ?? "");
      expect(listener.address).toBe(port);
      expect(Array.from(after.sha256[0] ?? [])).toEqual(
        Array.from(before.sha256[1] ?? []),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it("refuses to dial, since a Node client cannot pin a certificate hash", async () => {
    await expect(
      createWebTransportTransport().connect(
        "https://127.0.0.1:1#sha256=" + "00".repeat(SHA256_HEX_LENGTH / 2),
      ),
    ).rejects.toThrow("cannot dial WebTransport");
  });
});
