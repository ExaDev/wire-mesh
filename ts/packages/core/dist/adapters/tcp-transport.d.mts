import { Transport } from "../ports/transport.mjs";
//#region src/adapters/tcp-transport.d.ts
/** A Node net.Socket-based Transport: length-prefixed, CBOR-encoded frames over plain TCP -- matching Cascade's own transport shape, since interop with Cascade nodes is wire-mesh's stated goal. Framing (not TLS) is this adapter's own concern; a TLS-terminated variant is a separate adapter behind the same Transport contract. */
export declare function createTcpTransport(): Transport;
//#endregion