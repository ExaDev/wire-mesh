import { Z as ProtocolVersion, k as HandshakeFrame, x as DomainId } from "../protocol-DKGCdPBm.mjs";
//#region src/domain/handshake.d.ts
/** The highest protocol version this build of core understands. */
export declare const SUPPORTED_PROTOCOL_VERSION: ProtocolVersion;
export interface NegotiationResult {
  ok: boolean;
  /** The version both peers will speak for the rest of the session -- the lower of the two offered versions, so a peer never has to understand a frame shape it didn't advertise. */
  version: ProtocolVersion;
  /** Domains both peers advertised and that are not retired -- the only ones either side may address for the rest of the session. */
  sharedDomains: DomainId[];
}
/**
 * Negotiates protocol version and capability domains between a local and remote handshake -- the mechanism wire-mesh's handshake exists to provide, and agent-comms issue #31's fix: a mixed fleet of old and new peers negotiates down to what they both actually support, rather than one side silently misinterpreting frames the other can't produce yet.
 */
export declare function negotiate(local: HandshakeFrame, remote: HandshakeFrame): NegotiationResult;
//#endregion