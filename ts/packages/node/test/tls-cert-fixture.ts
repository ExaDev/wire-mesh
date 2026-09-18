import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";

export interface CertFixture {
  certificatePem: string;
  privateKeyPem: string;
  /** The raw, uncompressed SEC1 public-key point this certificate's own key pair carries -- what a peer authenticating this certificate should derive its device-id from. */
  rawPublicKey: Uint8Array;
}

/** Generates a throwaway, self-signed ECDSA P-256 certificate + key pair via the system `openssl` binary (present on every CI runner this project targets) -- wire-mesh itself has no certificate-generation code of its own to reuse (that's an agent-comms-side concern; createTlsTransport only ever consumes an already-built cert+key). Test-only tooling, never shipped. */
export function generateCertFixture(): CertFixture {
  const dir = mkdtempSync(join(tmpdir(), "wire-mesh-tls-test-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=wire-mesh-test",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    const privateKeyPem = readFileSync(keyPath, "utf8");
    const certificatePem = readFileSync(certPath, "utf8");
    const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
    const jwk = publicKey.export({ format: "jwk" });
    if (jwk.x === undefined || jwk.y === undefined) {
      throw new Error("expected an EC JWK with x/y coordinates");
    }
    // The uncompressed SEC1 point tag byte (RFC 5480 2.2): 0x04 marks what follows as raw X||Y, never compressed or hybrid encoding.
    const UNCOMPRESSED_POINT_TAG = 0x04;
    const rawPublicKey = new Uint8Array([
      UNCOMPRESSED_POINT_TAG,
      ...Buffer.from(jwk.x, "base64url"),
      ...Buffer.from(jwk.y, "base64url"),
    ]);
    return { certificatePem, privateKeyPem, rawPublicKey };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
