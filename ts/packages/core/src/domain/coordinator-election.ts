/* The gossiped, term-based coordinator election over coordinator-frame (spec/transport.cddl): pure state, no session or transport dependencies, so the same logic runs in any consumer exactly the way relay-hub.ts's own transport-agnostic core does. The spec fixes the whole algorithm and this module is only its mechanics: `term` is a monotonically increasing epoch a peer raises when claiming the role; a higher term always supersedes a lower one, and two simultaneous claims at equal terms are broken by lowest device-id, a verifier-side obligation the CDDL itself cannot enforce (the same idiom capability-token delegation's narrowing rule and room-notice ordering already use). This gives the rendezvous role the same crash-recovery property a port-race coordinator has (any live peer can take over by raising the term) without relying on OS-level port contention to do the electing.

   Ownership of when to claim, when to re-gossip, and what the role grants stays with the caller: this module only answers "given the claims I have seen, who holds the role" and mints a claim that beats them. A holder refreshing its claim for late joiners re-announces the incumbent unchanged (announceCurrent) rather than raising the term, because term inflation without a contest would make every refresh a takeover and destroy the monotonic epoch's meaning.

   Gossip propagation is the caller's transport concern, matching how peer-advert already travels: a claim this module mints reaches exactly the peers the sender's gossip reaches, and a claim evaluated here arrived the same way. There is no membership list to scope an election to (the mesh is the live connected component of the transport graph, nothing more), which is why the spec gossips this frame the same way it gossips peer-advert rather than addressing it to a roster. */

import type { CoordinatorFrame, DeviceId } from "../generated/protocol.js";

/** The claim this side currently accepts: one coordinator, at the term that put it there. */
export interface CoordinatorClaim {
  term: number;
  coordinator: DeviceId;
  capacityHint?: number | undefined;
}

/** Bytewise "lowest device-id" comparison, the equal-term tiebreak the spec names: shorter is lower when one id is a prefix of the other, and equal ids compare equal. Device-ids are a fixed 32 bytes today, so the prefix branch is completeness rather than a live case. */
export function compareDeviceIds(a: DeviceId, b: DeviceId): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) break;
    if (left !== right) return left < right ? -1 : 1;
  }

  return a.length - b.length;
}

/** Whether a claim at this term can be superseded by a later claim: a non-negative safe integer strictly below Number.MAX_SAFE_INTEGER, so that term + 1 is still an exactly represented, strictly greater integer. Above that ceiling a double cannot count on (2 ** 53 + 1 === 2 ** 53), and an incumbent there could never be superseded, so a device that named itself holder would keep the role for good even after it had gone. */
export function isSupersedableTerm(term: number): boolean {
  return (
    Number.isSafeInteger(term) && term >= 0 && term < Number.MAX_SAFE_INTEGER
  );
}

/** What evaluating an incoming claim concluded, so the caller can react without re-deriving the comparison: "accepted" means this claim is now the incumbent (it superseded a previous one, or there was none), "retained" means the incumbent survived (the incoming claim was stale, or lost the equal-term tiebreak), and the incumbent is returned either way so a caller squashing a stale claim re-announces exactly what it already holds. "rejected" means the claim's term is not one a later claim can supersede (isSupersedableTerm), so it was never compared: the incumbent, if any, is untouched, and there is nothing to answer it with. */
export type EvaluationOutcome =
  | { outcome: "accepted"; incumbent: CoordinatorClaim }
  | { outcome: "retained"; incumbent: CoordinatorClaim }
  | { outcome: "rejected" };

export interface CoordinatorElectionOptions {
  /** This device's own id: the coordinator named by a claim this side mints. */
  ownDevice: DeviceId;
}

export class CoordinatorElection {
  private readonly ownDevice: DeviceId;

  private incumbent: CoordinatorClaim | undefined;

  constructor(options: Readonly<CoordinatorElectionOptions>) {
    this.ownDevice = options.ownDevice;
  }

  /** The claim this side currently accepts, or undefined before any claim has been made or heard. */
  current(): CoordinatorClaim | undefined {
    return this.incumbent;
  }

  /** Whether this side's own device is the incumbent. */
  isSelf(): boolean {
    return (
      this.incumbent !== undefined &&
      compareDeviceIds(this.incumbent.coordinator, this.ownDevice) === 0
    );
  }

  /**
   * Claims the role for this side's own device at a term above every term seen so far (lastTerm + 1, so a first-ever claim is term 0), and returns the frame to gossip. Throws a RangeError when that term is not one peers accept (isSupersedableTerm), which only happens when the incumbent already sits at the highest term the election accepts. Claiming over a claim this side already holds is a deliberate takeover: it raises the term, which is exactly what a peer recovering the role after losing track of the mesh should do, and what a routine refresh should not (announceCurrent exists for that).
   */
  claim(capacityHint?: number): CoordinatorFrame {
    const lastTerm = this.incumbent?.term ?? -1;
    const term = lastTerm + 1;
    if (!isSupersedableTerm(term)) {
      throw new RangeError(
        `the incumbent's term ${String(lastTerm)} leaves no term a claim can be raised to`,
      );
    }
    const frame: CoordinatorFrame = {
      type: "coordinator",
      term,
      coordinator: this.ownDevice,
      ...(capacityHint !== undefined ? { "capacity-hint": capacityHint } : {}),
    };
    this.incumbent = {
      term: frame.term,
      coordinator: this.ownDevice,
      ...(capacityHint !== undefined ? { capacityHint: capacityHint } : {}),
    };

    return frame;
  }

  /**
   * The incumbent claim as a frame to re-gossip, for a holder refreshing what late joiners see (and for answering a stale claim, which costs the incumbent nothing to squash): the term is unchanged, because a refresh is not a takeover. Undefined when no claim has been made or heard yet.
   */
  announceCurrent(): CoordinatorFrame | undefined {
    if (this.incumbent === undefined) return undefined;

    return {
      type: "coordinator",
      term: this.incumbent.term,
      coordinator: this.incumbent.coordinator,
      ...(this.incumbent.capacityHint !== undefined
        ? { "capacity-hint": this.incumbent.capacityHint }
        : {}),
    };
  }

  /**
   * Evaluates an incoming claim against the one this side currently accepts: a strictly higher term always wins; an equal term breaks by lowest device-id, so an incoming claim naming a lower device-id than the incumbent's takes the role and one naming a higher device-id loses; a lower term never wins. "accepted" means the incumbent changed (the caller should gossip the new incumbent onward so the supersession propagates); "retained" means it did not (the caller may answer a stale claim by re-gossiping announceCurrent(), and should drop a lost equal-term claim it originated, since the tiebreak has settled it); "rejected" means the claim's term is not supersedable (isSupersedableTerm), so it is dropped unevaluated and the caller should neither gossip nor answer it.
   */
  evaluate(frame: Readonly<CoordinatorFrame>): EvaluationOutcome {
    if (!isSupersedableTerm(frame.term)) {
      return { outcome: "rejected" };
    }
    const previous = this.incumbent;
    if (
      previous === undefined ||
      frame.term > previous.term ||
      (frame.term === previous.term &&
        compareDeviceIds(frame.coordinator, previous.coordinator) < 0)
    ) {
      this.incumbent = {
        term: frame.term,
        coordinator: frame.coordinator,
        ...(frame["capacity-hint"] !== undefined
          ? { capacityHint: frame["capacity-hint"] }
          : {}),
      };

      return { outcome: "accepted", incumbent: this.incumbent };
    }

    return { outcome: "retained", incumbent: previous };
  }
}
