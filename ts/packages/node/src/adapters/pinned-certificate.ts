// @peculiar/x509 resolves its parts through tsyringe, which refuses to load without this polyfill (its documented requirement).
import "reflect-metadata";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";

import { PINNED_CERTIFICATE_LIFETIME_MS } from "./certificate-limits.js";

const SERIAL_NUMBER_BYTES = 16;
const PEM_LINE_LENGTH = 64;

const SIGNING_ALGORITHM = {
  name: "ECDSA",
  namedCurve: "P-256",
  hash: "SHA-256",
} as const;

/** A self-signed certificate a browser can accept by pinning its hash, with the private key to serve it. */
export interface PinnedCertificate {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  /** SHA-256 of the certificate's DER encoding, lowercase hex: the value a client pins. */
  readonly sha256Hex: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

function toHex(bytes: Readonly<Uint8Array>): string {
  return Buffer.from(bytes).toString("hex");
}

function toPem(label: string, der: Readonly<ArrayBuffer>): string {
  const base64 = Buffer.from(der).toString("base64");
  const lines =
    base64.match(new RegExp(`.{1,${String(PEM_LINE_LENGTH)}}`, "g")) ?? [];

  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * Mints an ECDSA P-256 certificate valid from `notBefore` for `lifetimeMs` (PINNED_CERTIFICATE_LIFETIME_MS unless a test asks for less). Clients pin it by hash rather than by name, so it carries only a common name.
 */
export async function mintPinnedCertificate(
  notBefore: Readonly<Date>,
  lifetimeMs: number = PINNED_CERTIFICATE_LIFETIME_MS,
): Promise<PinnedCertificate> {
  const keys = await crypto.subtle.generateKey(SIGNING_ALGORITHM, true, [
    "sign",
    "verify",
  ]);
  const notAfter = new Date(notBefore.getTime() + lifetimeMs);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: toHex(
      crypto.getRandomValues(new Uint8Array(SERIAL_NUMBER_BYTES)),
    ),
    name: "CN=wire-mesh",
    notBefore,
    notAfter,
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    // A leaf a TLS server may present: not a CA, usable for signatures and for serving.
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], true),
    ],
  });
  const digest = await crypto.subtle.digest("SHA-256", certificate.rawData);

  return {
    certificatePem: certificate.toString("pem"),
    privateKeyPem: toPem(
      "PRIVATE KEY",
      await crypto.subtle.exportKey("pkcs8", keys.privateKey),
    ),
    sha256Hex: toHex(new Uint8Array(digest)),
    notBefore,
    notAfter,
  };
}
