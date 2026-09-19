/**
 * `relay:use` enforcement (wire-mesh#48): gates who may ask an ordinary, opted-in node to relay for them, distinct from a dedicated wire-mesh/cloudflare-hub deployment, which can reasonably stay open to anyone gossiped. `spec/transport.cddl`'s own comment on `relay-connect-frame` already states the intended shape directly: "who is allowed to use a given relay as a service is deliberately not part of this shape... an operator that wants to gate relay access enforces it the same way any other behaviour is gated in this schema — an ordinary core/management verb checked before honouring subsequent relay frames on that connection." This module is exactly that check, built as a thin wrapper around a RelayHub's own onFrame (wire-mesh#102) rather than inside relay-hub.ts itself, which stays deliberately domain-agnostic and knows nothing of capability tokens.
 *
 * Composition, left to the caller rather than baked in here: a node opting into gated relaying runs `capability-request.ts`'s own generic `createCapabilityRequestHandler({ capability: "relay:use", ... })` against each accepted session's `incomingManageRequests`, calling `authorize(connection)` from that handler's own onRequest/decide on acceptance -- the identical `capability.request`/ask-held-open-decide-mint primitive `room:member` and `webrtc:signal` already reuse, not a bespoke relay-specific flow.
 */

import type { Frame } from "../generated/protocol.js";
import type { Connection } from "../ports/transport.js";

export interface RelayUseAuthorizationTracker {
  /** True once authorize() has been called for this exact connection and revoke() has not been called since. */
  isAuthorized: (connection: Readonly<Connection>) => boolean;
  /** Marks a connection as holding a currently-valid relay:use grant -- called from the accepting side of a capability-request/capability-grant-ok exchange once it decides to grant. */
  authorize: (connection: Readonly<Connection>) => void;
  /** Withdraws a connection's own authorization, e.g. once its granted token's own expiry has passed or it was revoked. Tracking here is a live boolean, not the token itself -- a caller enforcing expiry calls this when it decides the grant is no longer current. */
  revoke: (connection: Readonly<Connection>) => void;
}

/** An in-memory, per-connection authorization set. Keyed by Connection identity (reference equality), matching RelayHub's own registry -- a connection that reconnects is a new object and starts unauthorized again, exactly as a fresh relay-hub registration would. */
export function createRelayUseAuthorizationTracker(): RelayUseAuthorizationTracker {
  const authorized = new Set<Readonly<Connection>>();
  return {
    isAuthorized: (connection) => authorized.has(connection),
    authorize: (connection) => {
      authorized.add(connection);
    },
    revoke: (connection) => {
      authorized.delete(connection);
    },
  };
}

export interface CreateGatedRelayFrameHandlerOptions {
  /** The RelayHub method this gate wraps -- typically a real RelayHub's own onFrame (wire-mesh#102), but accepting just the one method it needs keeps this module decoupled from RelayHub's full interface. */
  onFrame: (connection: Readonly<Connection>, frame: Frame) => Promise<void>;
  isAuthorized: (connection: Readonly<Connection>) => boolean;
}

/**
 * Wraps a RelayHub's own onFrame with the relay:use check: a relay-connect from an unauthorized connection is silently dropped before ever reaching the hub, matching relay-connect-frame's own existing "no error frame defined for this" precedent for an unresolvable request (spec/transport.cddl, relay-hub.ts's own handleFrame comment for an unknown target-device). Every other frame type passes through unconditionally -- gossip needs no gate (it carries no relay effect on its own), and relay-data needs none either, since it can only ever act within a pairing that itself required an authorized relay-connect to establish in the first place; gating it again would be redundant, not additionally safe.
 */
export function createGatedRelayFrameHandler(
  options: Readonly<CreateGatedRelayFrameHandlerOptions>,
): (connection: Readonly<Connection>, frame: Frame) => Promise<void> {
  return async function gatedOnFrame(connection, frame): Promise<void> {
    if (frame.type === "relay-connect" && !options.isAuthorized(connection)) {
      return;
    }
    await options.onFrame(connection, frame);
  };
}
