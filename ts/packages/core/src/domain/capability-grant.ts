/**
 * The generic, capability-agnostic capability-grant primitive (wire-mesh#117, spec/management.cddl) -- the unsolicited push counterpart to capability-request.ts's own ask/response primitive. Where capability-request lifts core/room's room.join shape (a pull: the requester asks, the owner mints and returns a grant on the same response) out of that one domain, capability-grant lifts room.invite's own shape (a push: the owner mints unprompted and delivers the grant in the request itself, since there is no approval round-trip to carry it back) the same way. core/room's own room-client.ts is the reference consumer: it builds sendRoomInvite as a thin wrapper over sendCapabilityGrant below, and wires createRoomRouter's dispatch onto createCapabilityGrantHandler for the receiving side.
 *
 * Two responsibilities, split the same way capability-request.ts already splits them: sendCapabilityGrant is the pushing side (a thin wrapper over MeshSession.sendManageRequest), and createCapabilityGrantHandler is the receiving side (validates the pushed token against all four of management.cddl's own capability-grant obligations, then hands the verified grant to the domain). Unlike capability-request's handler, there is no decide()/timeout mechanism here: management.cddl deliberately specifies no protocol-level approval round trip for this primitive (a receiver's manage-response reports validation success or failure only, never a human decision), so onGrant is a plain notification callback, not an event carrying its own responder.
 */

import {
  capabilityGrantSchema,
  type CapabilityScope,
  type CapabilityToken,
  type DeviceId,
  type ManageCommand,
} from "../generated/protocol.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "./mesh-session.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityPort } from "../ports/identity.js";
import { scopeNarrows } from "./token-scope.js";
import { verifyCapabilityToken, type RevocationCheck } from "./tokens.js";

/**
 * Builds a capability-grant command per management.cddl. The outer `manage-command.verb` is the capability string itself, the identical convention capability-request.ts's own buildCapabilityRequestCommand already establishes -- a receiver's per-capability handler is how it knows which grant this push is even for. `params.verb` is the fixed "capability.grant" marker. No scope or invitee field: manage-request-frame's own top-level scope already carries the former, and the request's own destination already carries the latter -- naming either a second time inside params could only ever disagree with the fact it duplicates.
 */
export function buildCapabilityGrantCommand(
  capability: string,
  grantedToken: CapabilityToken,
): ManageCommand {
  return {
    verb: capability,
    params: {
      verb: "capability.grant",
      "granted-token": grantedToken,
    },
  };
}

/**
 * Pushes an already-minted grantedToken to whichever peer this request is addressed to -- the caller mints grantedToken itself beforehand (there is no minting step here, unlike capability-request's own accept path, since this primitive carries a token the sender already decided to hand over unprompted). Resolves with the raw manage-response outcome: `{result:"ok"}` on successful validation, an ordinary manage-error otherwise (per management.cddl's own capability-grant obligations, this is a validation-failure code only, never a human "no" -- an application wanting a human-decision gate applies it on the RECEIVING side's own onGrant callback instead, exactly as core/room's own room.invite→room_invite delivery event already does today in agent-comms).
 *
 * scope and targetDevice forward directly to MeshSession.sendManageRequest's own identically-named parameters (the request's own top-level scope obligation 4 checks the token against, and relay routing respectively).
 */
export async function sendCapabilityGrant(
  session: Readonly<MeshSession>,
  capability: string,
  grantedToken: CapabilityToken,
  scope: Readonly<CapabilityScope>,
  targetDevice?: DeviceId,
): Promise<ManageOutcome> {
  return session.sendManageRequest(
    buildCapabilityGrantCommand(capability, grantedToken),
    scope,
    targetDevice,
  );
}

/** One incoming, fully-verified capability-grant, surfaced for the domain to react to (store the token, notify a human, etc.) -- there is no decide() here because management.cddl specifies no protocol-level approval round trip for this primitive; by the time onGrant fires, the wire response has already been sent. */
export interface CapabilityGrantEvent {
  /** The capability granted -- equals both the outer manage-command.verb and the verified token's own capability claim (obligation 2 already enforced this before onGrant fires). */
  capability: string;
  /** The pushed token, already confirmed to independently pass every ordinary verifyCapabilityToken obligation, name this receiver as its own bearer, and scope-match the enclosing request (obligations 1, 2, 3, and 4 respectively). Ready to use exactly as capability-request.ts's own CapabilityGrantOk["granted-token"] is on the pull side. */
  grantedToken: CapabilityToken;
  /** The scope this grant's own manage-request-frame carried -- e.g. core/room's `{kind:"room", path: roomPath}` -- passed through unchanged so the domain can inspect it (a room handler reads `.path` back out) without this module needing to know its shape. */
  scope: Readonly<CapabilityScope>;
  /** The peer device-id authenticated on the connection this grant arrived on -- the granter, surfaced so the domain can attribute the push (e.g. core/room's own room_invite event names the inviter). Never itself checked against the token's bearer (obligation 1 checks the RECIPIENT's own identity instead -- an unsolicited push names its own recipient by where it was sent, not by who sent it). */
  granterDevice: DeviceId;
}

export interface CreateCapabilityGrantHandlerOptions {
  /** The capability this handler accepts pushed grants for. Checked against the incoming command's own outer verb (a mismatch is refused as malformed, mirroring capability-request.ts's identical capability check) and against the verified token's own capability claim (obligation 2); a caller wanting to accept grants for several distinct capabilities over one session constructs one handler per capability, the same way core/room constructs one handler for `room:member` and nothing else. */
  capability: string;
  /** This receiver's own identity -- both the verification primitives every pushed token is checked with, and (via `.deviceId`) the value obligation 1 requires the token's own bearer to equal. There is no separate bearerDevice option the way CreateCapabilityRequestHandlerOptions has one: capability-request's handler mints a NEW token for whichever peer asked, so it needs that peer's device-id as an input; capability-grant's handler verifies an ALREADY-minted token against this side's own identity, which identity.deviceId already provides. */
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationCheck;
  /** The peer device-id authenticated on this session's own connection -- the granter, surfaced on every CapabilityGrantEvent so the domain can attribute the push. Never used for verification itself (see CapabilityGrantEvent.granterDevice's own doc comment on why obligation 1 checks the recipient's identity instead). */
  granterDevice: DeviceId;
  /** Called once per incoming, fully-verified capability-grant. Fires after the wire response has already been sent (see createCapabilityGrantHandler's own doc comment) -- this is a notification, not a decision point. */
  onGrant: (event: Readonly<CapabilityGrantEvent>) => void;
}

/**
 * Builds a reusable handler for one capability's incoming capability-grants. The returned function checks, in order: the outer verb names this handler's own capability (otherwise `{result:"error", code:"malformed"}`, matching capability-request.ts's identical check); the params payload parses against capability-grant's own CDDL shape (otherwise "malformed"); the embedded token independently passes every ordinary verifyCapabilityToken obligation with `expectedBearer` set to this receiver's OWN identity -- obligations 1 and 3 together, since an unsolicited push must name its actual recipient as bearer and must otherwise be exactly as valid as any other token (a verification failure responds with verifyCapabilityToken's own specific TokenVerdictReason as the error code, e.g. "expired"/"revoked"/"bad_signature", rather than a single generic code, mirroring how capability-request.ts already distinguishes "expired" from "malformed"); the token's own capability claim equals this handler's capability (obligation 2, otherwise "capability_mismatch"); and the token's own scope equals or roots the enclosing request's own top-level scope (obligation 4, via tokens.ts's own scopeNarrows -- otherwise "scope_mismatch"). Only once every obligation passes does it respond `{result:"ok"}` and invoke onGrant -- there is no decide()/timeout mechanism the way createCapabilityRequestHandler has one, since management.cddl specifies no protocol-level approval round trip for this primitive at all.
 */
export function createCapabilityGrantHandler(
  options: Readonly<CreateCapabilityGrantHandlerOptions>,
): (incoming: Readonly<IncomingManageRequest>) => Promise<void> {
  return async function handleCapabilityGrant(
    incoming: Readonly<IncomingManageRequest>,
  ): Promise<void> {
    if (incoming.command.verb !== options.capability) {
      await incoming.respond({ result: "error", code: "malformed" });
      return;
    }
    const parsed = capabilityGrantSchema.safeParse(incoming.command.params);
    if (!parsed.success) {
      await incoming.respond({ result: "error", code: "malformed" });
      return;
    }
    const grantedToken = parsed.data["granted-token"];

    const verdict = await verifyCapabilityToken(grantedToken, {
      identity: options.identity,
      clock: options.clock,
      revocation: options.revocation,
      expectedBearer: options.identity.deviceId,
    });
    if (!verdict.ok) {
      await incoming.respond({ result: "error", code: verdict.reason });
      return;
    }

    if (verdict.claims.capability !== options.capability) {
      await incoming.respond({
        result: "error",
        code: "capability_mismatch",
      });
      return;
    }

    if (!scopeNarrows(verdict.claims.scope, incoming.scope)) {
      await incoming.respond({ result: "error", code: "scope_mismatch" });
      return;
    }

    await incoming.respond({ result: "ok" });
    options.onGrant({
      capability: options.capability,
      grantedToken,
      scope: incoming.scope,
      granterDevice: options.granterDevice,
    });
  };
}
