//! The gossiped, term-based coordinator election over `coordinator-frame` (`spec/transport.cddl`), ported from `coordinator-election.ts`: pure state with no session or transport dependency.
//!
//! `term` is a monotonically increasing epoch a peer raises when claiming the role. A higher term always supersedes a lower one, and two claims at equal terms are broken by the lowest device-id, a verifier-side obligation the CDDL cannot enforce.
//!
//! When to claim, when to re-gossip and what the role grants stay with the caller: this module answers which claim a side holds and mints a claim that beats it. A holder refreshing its claim re-announces the incumbent unchanged ([`CoordinatorElection::announce_current`]) rather than raising the term, because a refresh that raised the term would be a takeover.

use std::cmp::Ordering;

use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::transport::CoordinatorFrame;

use crate::domain::mint::MAX_EXACT_INTEGER;

/// The claim a side currently accepts: one coordinator, at the term that put it there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinatorClaim {
    pub term: u64,
    pub coordinator: DeviceId,
    pub capacity_hint: Option<u64>,
}

/// Whether a claim at this term can be superseded by a later one. This is a rule about terms only; a capacity hint is bounded by [`MAX_EXACT_INTEGER`] itself. The term must be strictly below [`MAX_EXACT_INTEGER`], so that `term + 1` is still exactly represented in an implementation with a double-sized integer. An incumbent above that could never be superseded, so a device that named itself holder would keep the role for good even after it had gone.
#[must_use]
pub fn is_supersedable_term(term: u64) -> bool {
    term < MAX_EXACT_INTEGER
}

/// What evaluating an incoming claim concluded, so the caller can react without re-deriving the comparison.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvaluationOutcome {
    /// The claim is now the incumbent (it superseded the previous one, or there was none): the caller should gossip it onward.
    Accepted { incumbent: CoordinatorClaim },
    /// The incumbent survived (the claim was stale, or lost the equal-term tiebreak). The incumbent is returned so a caller squashing a stale claim re-announces exactly what it holds.
    Retained { incumbent: CoordinatorClaim },
    /// The claim's term is not one a later claim can supersede ([`is_supersedable_term`]), or its capacity hint is above [`MAX_EXACT_INTEGER`], which a TypeScript peer drops as malformed: either way it was never compared, the incumbent is untouched, and there is nothing to answer it with and nothing to gossip onward.
    Rejected,
}

/// Why [`CoordinatorElection::claim`] made no claim. The state is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimRefusal {
    /// The incumbent already sits at the highest term the election accepts, so no term a claim can be raised to is left.
    NoSupersedableTerm {
        /// The incumbent's term, which the next claim would have to exceed.
        incumbent_term: u64,
    },
    /// The capacity hint is above [`MAX_EXACT_INTEGER`], an integer the TypeScript cannot hold exactly, so a peer running it could not read the claim. Rust only, as the other minters' `value_not_representable`.
    CapacityHintNotRepresentable,
}

impl std::fmt::Display for ClaimRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClaimRefusal::NoSupersedableTerm { incumbent_term } => write!(
                f,
                "the incumbent's term {incumbent_term} leaves no term a claim can be raised to"
            ),
            ClaimRefusal::CapacityHintNotRepresentable => {
                f.write_str("the capacity hint is above 2^53 - 1")
            }
        }
    }
}

impl std::error::Error for ClaimRefusal {}

/// One side's view of the election: its own device and the claim it currently accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinatorElection {
    own_device: DeviceId,
    incumbent: Option<CoordinatorClaim>,
}

impl CoordinatorElection {
    /// A side with no claim made or heard. `own_device` is the coordinator named by a claim this side mints.
    #[must_use]
    pub fn new(own_device: DeviceId) -> Self {
        CoordinatorElection {
            own_device,
            incumbent: None,
        }
    }

    /// The claim this side currently accepts, or `None` before any claim has been made or heard.
    #[must_use]
    pub fn current(&self) -> Option<&CoordinatorClaim> {
        self.incumbent.as_ref()
    }

    /// Whether this side's own device is the incumbent.
    #[must_use]
    pub fn is_self(&self) -> bool {
        self.incumbent
            .as_ref()
            .is_some_and(|claim| claim.coordinator == self.own_device)
    }

    /// Claims the role for this side's own device at a term above every term seen so far (the incumbent's plus one, so a first-ever claim is term 0), and returns the frame to gossip.
    ///
    /// Claiming over a claim this side already holds is a deliberate takeover: it raises the term, which is what a peer recovering the role after losing track of the mesh should do and what a routine refresh should not ([`Self::announce_current`] exists for that).
    ///
    /// # Errors
    ///
    /// [`ClaimRefusal::NoSupersedableTerm`] when the incumbent already sits at the highest term the election accepts, and [`ClaimRefusal::CapacityHintNotRepresentable`] when `capacity_hint` is above 2^53 - 1 (checked first). The state is unchanged.
    pub fn claim(&mut self, capacity_hint: Option<u64>) -> Result<CoordinatorFrame, ClaimRefusal> {
        if capacity_hint.is_some_and(|hint| hint > MAX_EXACT_INTEGER) {
            return Err(ClaimRefusal::CapacityHintNotRepresentable);
        }
        let term = match &self.incumbent {
            None => 0,
            Some(claim) => claim.term + 1,
        };
        if !is_supersedable_term(term) {
            return Err(ClaimRefusal::NoSupersedableTerm {
                incumbent_term: term.saturating_sub(1),
            });
        }
        self.incumbent = Some(CoordinatorClaim {
            term,
            coordinator: self.own_device,
            capacity_hint,
        });
        Ok(CoordinatorFrame {
            term,
            coordinator: self.own_device,
            capacity_hint,
        })
    }

    /// The incumbent claim as a frame to re-gossip, for a holder refreshing what late joiners see and for answering a stale claim: the term is unchanged, because a refresh is not a takeover. `None` when no claim has been made or heard.
    #[must_use]
    pub fn announce_current(&self) -> Option<CoordinatorFrame> {
        self.incumbent.as_ref().map(|claim| CoordinatorFrame {
            term: claim.term,
            coordinator: claim.coordinator,
            capacity_hint: claim.capacity_hint,
        })
    }

    /// Evaluates an incoming claim against the one this side accepts: a strictly higher term wins, an equal term breaks by the lowest device-id, and a lower term never wins. A claim whose term is not supersedable, or whose capacity hint is above [`MAX_EXACT_INTEGER`], is dropped unevaluated.
    pub fn evaluate(&mut self, frame: &CoordinatorFrame) -> EvaluationOutcome {
        if !is_supersedable_term(frame.term)
            || frame
                .capacity_hint
                .is_some_and(|hint| hint > MAX_EXACT_INTEGER)
        {
            return EvaluationOutcome::Rejected;
        }
        let candidate = CoordinatorClaim {
            term: frame.term,
            coordinator: frame.coordinator,
            capacity_hint: frame.capacity_hint,
        };
        match &self.incumbent {
            Some(previous) if !supersedes(&candidate, previous) => EvaluationOutcome::Retained {
                incumbent: previous.clone(),
            },
            _ => {
                self.incumbent = Some(candidate.clone());
                EvaluationOutcome::Accepted {
                    incumbent: candidate,
                }
            }
        }
    }
}

/// Whether `candidate` takes the role from `incumbent`: a strictly higher term, or an equal term with the lower device-id.
fn supersedes(candidate: &CoordinatorClaim, incumbent: &CoordinatorClaim) -> bool {
    match candidate.term.cmp(&incumbent.term) {
        Ordering::Greater => true,
        Ordering::Equal => candidate.coordinator < incumbent.coordinator,
        Ordering::Less => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOW: DeviceId = DeviceId([1; 32]);
    const MID: DeviceId = DeviceId([2; 32]);
    const HIGH: DeviceId = DeviceId([3; 32]);

    fn frame(term: u64, coordinator: DeviceId) -> CoordinatorFrame {
        CoordinatorFrame {
            term,
            coordinator,
            capacity_hint: None,
        }
    }

    #[test]
    fn a_first_claim_is_term_zero_and_makes_the_side_the_incumbent() {
        let mut election = CoordinatorElection::new(MID);
        assert_eq!(election.current(), None);
        assert!(!election.is_self());
        let claimed = election.claim(None).expect("a first claim");
        assert_eq!(claimed, frame(0, MID));
        assert!(election.is_self());
    }

    #[test]
    fn a_second_claim_raises_the_term() {
        let mut election = CoordinatorElection::new(MID);
        election.claim(None).expect("first");
        assert_eq!(election.claim(Some(64)).expect("second").term, 1);
        assert_eq!(election.current().expect("held").capacity_hint, Some(64));
    }

    #[test]
    fn a_higher_term_supersedes_and_a_lower_one_is_retained() {
        let mut election = CoordinatorElection::new(MID);
        assert!(matches!(
            election.evaluate(&frame(5, HIGH)),
            EvaluationOutcome::Accepted { .. }
        ));
        let EvaluationOutcome::Retained { incumbent } = election.evaluate(&frame(4, LOW)) else {
            panic!("a lower term is retained");
        };
        assert_eq!((incumbent.term, incumbent.coordinator), (5, HIGH));
    }

    #[test]
    fn an_equal_term_goes_to_the_lowest_device_id_and_a_repeat_is_retained() {
        let mut election = CoordinatorElection::new(MID);
        election.evaluate(&frame(2, HIGH));
        assert!(matches!(
            election.evaluate(&frame(2, LOW)),
            EvaluationOutcome::Accepted { .. }
        ));
        assert!(matches!(
            election.evaluate(&frame(2, MID)),
            EvaluationOutcome::Retained { .. }
        ));
        assert!(matches!(
            election.evaluate(&frame(2, LOW)),
            EvaluationOutcome::Retained { .. }
        ));
    }

    #[test]
    fn a_claim_after_hearing_a_higher_term_beats_it() {
        let mut election = CoordinatorElection::new(MID);
        election.evaluate(&frame(7, LOW));
        assert_eq!(election.claim(None).expect("beats it").term, 8);
        assert!(election.is_self());
    }

    #[test]
    fn a_term_with_no_room_above_it_is_never_accepted_and_never_claimed_over() {
        let mut election = CoordinatorElection::new(MID);
        assert_eq!(
            election.evaluate(&frame(MAX_EXACT_INTEGER, LOW)),
            EvaluationOutcome::Rejected
        );
        assert_eq!(election.current(), None);
        election.evaluate(&frame(MAX_EXACT_INTEGER - 1, LOW));
        assert_eq!(
            election.claim(None),
            Err(ClaimRefusal::NoSupersedableTerm {
                incumbent_term: MAX_EXACT_INTEGER - 1
            })
        );
        assert_eq!(
            election.current().expect("held").term,
            MAX_EXACT_INTEGER - 1
        );
    }

    #[test]
    fn announcing_the_incumbent_keeps_its_term_and_capacity_hint() {
        let mut election = CoordinatorElection::new(MID);
        assert_eq!(election.announce_current(), None);
        election.claim(Some(9)).expect("claim");
        let announced = election.announce_current().expect("incumbent");
        assert_eq!(announced.term, 0);
        assert_eq!(announced.capacity_hint, Some(9));
    }

    #[test]
    fn a_capacity_hint_the_typescript_cannot_hold_exactly_is_refused_and_changes_nothing() {
        let mut election = CoordinatorElection::new(MID);
        assert_eq!(
            election.claim(Some(MAX_EXACT_INTEGER + 1)),
            Err(ClaimRefusal::CapacityHintNotRepresentable)
        );
        assert_eq!(election.current(), None);
        let frame = election
            .claim(Some(MAX_EXACT_INTEGER))
            .expect("the largest exact hint");
        assert_eq!(frame.capacity_hint, Some(MAX_EXACT_INTEGER));
    }

    #[test]
    fn a_received_capacity_hint_above_the_exact_integers_is_rejected_and_changes_nothing() {
        let mut election = CoordinatorElection::new(MID);
        let beyond = CoordinatorFrame {
            term: 5,
            coordinator: LOW,
            capacity_hint: Some(MAX_EXACT_INTEGER + 1),
        };
        assert_eq!(election.evaluate(&beyond), EvaluationOutcome::Rejected);
        assert_eq!(election.current(), None);
        election.evaluate(&frame(1, HIGH));
        assert_eq!(election.evaluate(&beyond), EvaluationOutcome::Rejected);
        assert_eq!(election.current().expect("held").term, 1);
        let at_the_limit = CoordinatorFrame {
            capacity_hint: Some(MAX_EXACT_INTEGER),
            ..beyond
        };
        assert!(matches!(
            election.evaluate(&at_the_limit),
            EvaluationOutcome::Accepted { .. }
        ));
    }
}
