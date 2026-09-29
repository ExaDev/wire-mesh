import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import {
  mintPinnedCertificate,
  PINNED_CERTIFICATE_LIFETIME_MS,
  type PinnedCertificate,
} from "./pinned-certificate.js";

/** How many certificates an address lists: the one being served and the ones that will replace it. A browser accepts the server's certificate when it matches any pinned hash, so an address stays usable until the last certificate it lists stops being served, which is this many rotation intervals after the one it was copied in. */
export const ADVERTISED_CERTIFICATES = 3;

/** A certificate is served for half its lifetime, so each successor is already valid, and its hash already listed, well before it takes over. */
const SERVING_FRACTION = 0.5;

const STORAGE_KEY = "webtransport-certificates";

/** The certificates a node serves in turn. */
export interface CertificateSchedule {
  /** The certificate to serve now. */
  readonly serving: PinnedCertificate;
  /** The serving certificate and those that follow it, in the order they take over: what an address lists. */
  readonly advertised: readonly PinnedCertificate[];
  /** When the certificate after `serving` takes over. */
  readonly rotatesAt: Date;
}

interface StoredCertificate {
  certificatePem: string;
  privateKeyPem: string;
  sha256Hex: string;
  notBefore: string;
  notAfter: string;
}

function isStoredCertificate(value: unknown): value is StoredCertificate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "certificatePem" in value &&
    typeof value.certificatePem === "string" &&
    "privateKeyPem" in value &&
    typeof value.privateKeyPem === "string" &&
    "sha256Hex" in value &&
    typeof value.sha256Hex === "string" &&
    "notBefore" in value &&
    typeof value.notBefore === "string" &&
    "notAfter" in value &&
    typeof value.notAfter === "string"
  );
}

function fromStored(stored: Readonly<StoredCertificate>): PinnedCertificate {
  return {
    certificatePem: stored.certificatePem,
    privateKeyPem: stored.privateKeyPem,
    sha256Hex: stored.sha256Hex,
    notBefore: new Date(stored.notBefore),
    notAfter: new Date(stored.notAfter),
  };
}

function toStored(certificate: Readonly<PinnedCertificate>): StoredCertificate {
  return {
    certificatePem: certificate.certificatePem,
    privateKeyPem: certificate.privateKeyPem,
    sha256Hex: certificate.sha256Hex,
    notBefore: certificate.notBefore.toISOString(),
    notAfter: certificate.notAfter.toISOString(),
  };
}

async function readStored(
  storage: Readonly<KeyValueStorage>,
): Promise<PinnedCertificate[]> {
  const bytes = await storage.get(STORAGE_KEY);
  if (bytes === undefined) {
    return [];
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(parsed) || !parsed.every(isStoredCertificate)) {
    throw new Error(`the stored ${STORAGE_KEY} are not in the expected shape`);
  }
  return parsed.map(fromStored);
}

async function writeStored(
  storage: Readonly<KeyValueStorage>,
  certificates: readonly PinnedCertificate[],
): Promise<void> {
  await storage.set(
    STORAGE_KEY,
    new TextEncoder().encode(JSON.stringify(certificates.map(toStored))),
  );
}

export interface CertificateScheduleOptions {
  /** How long each certificate is valid; PINNED_CERTIFICATE_LIFETIME_MS unless a test asks for less. */
  readonly lifetimeMs?: number;
}

/**
 * Keeps a rolling schedule of pinned certificates in `storage`: the one serving now and enough successors that an address lists ADVERTISED_CERTIFICATES of them. Each successor starts one serving period after its predecessor, so it is valid, and pinned, before it takes over.
 *
 * `advance` brings the schedule up to `now`: certificates that have finished serving are dropped, missing successors are minted, and if nothing stored is serving (a first run, or a node that was down past every stored certificate) a certificate valid from `now` starts a new schedule. What it returns is written back, so a restart resumes the same certificates and the addresses already handed out stay valid.
 */
export async function advanceCertificateSchedule(
  storage: Readonly<KeyValueStorage>,
  now: Readonly<Date>,
  options: Readonly<CertificateScheduleOptions> = {},
): Promise<CertificateSchedule> {
  const lifetimeMs = options.lifetimeMs ?? PINNED_CERTIFICATE_LIFETIME_MS;
  const servingMs = lifetimeMs * SERVING_FRACTION;
  const stored = await readStored(storage);
  const stillValid = stored.filter(
    (certificate) => certificate.notAfter.getTime() > now.getTime(),
  );
  const startedIndex = stillValid.findLastIndex(
    (certificate) => certificate.notBefore.getTime() <= now.getTime(),
  );
  const certificates: PinnedCertificate[] =
    startedIndex === -1
      ? [await mintPinnedCertificate(now, lifetimeMs)]
      : stillValid.slice(startedIndex);
  while (certificates.length < ADVERTISED_CERTIFICATES + 1) {
    const last = certificates[certificates.length - 1];
    if (last === undefined) {
      throw new Error("the certificate schedule is empty");
    }
    certificates.push(
      await mintPinnedCertificate(
        new Date(last.notBefore.getTime() + servingMs),
        lifetimeMs,
      ),
    );
  }
  await writeStored(storage, certificates);
  const [serving, next] = certificates;
  if (serving === undefined || next === undefined) {
    throw new Error("the certificate schedule is empty");
  }
  return {
    serving,
    advertised: certificates.slice(0, ADVERTISED_CERTIFICATES),
    rotatesAt: next.notBefore,
  };
}
