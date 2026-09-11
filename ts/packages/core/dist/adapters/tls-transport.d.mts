import { Transport } from "../ports/transport.mjs";
//#region src/adapters/tls-transport.d.ts
export interface TlsIdentity {
  certificatePem: string;
  privateKeyPem: string;
}
/** A Node tls.TLSSocket-based Transport: the identical length-prefixed CBOR framing createTcpTransport uses, but over mutually-authenticated TLS -- both sides always present the certificate from the identity passed in, and rejectUnauthorized stays false deliberately (this is certificate-pinning by device-id, the Syncthing trust model, not a CA hierarchy) while Connection.peerDeviceId carries the one thing that actually matters: what the presented certificate cryptographically proves the peer holds the key for. */
export declare function createTlsTransport(identity: Readonly<TlsIdentity>): Transport;
//#endregion