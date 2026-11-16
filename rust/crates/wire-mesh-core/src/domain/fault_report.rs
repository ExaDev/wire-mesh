//! How a fault is told to its owner: at most one report per source per interval, with the number of faults withheld since the last report, and a bounded number of sources and reports across all of them, so what a peer can make this side report is bounded however many sources it presents. The rules are those of the TypeScript `createFaultReporter`.
//!
//! The reporter owns no timer, since a domain module has no runtime. A report held back at the end of an interval is handed out by [`FaultReporter::due`], which the owner calls when [`FaultReporter::next_due`] says an interval has ended, as the TypeScript's timer does. A fault of a source whose interval has ended, arriving before the owner called [`FaultReporter::due`], is delivered at once with the count that was pending, as the TypeScript does when it arrives before the timer fires.

use std::collections::HashMap;

/// The shortest time between two reports for one source.
pub const FAULT_REPORT_INTERVAL_MS: u64 = 1_000;

/// The most sources whose report windows are kept at once; past it the oldest window goes, and the faults it still had pending are added to the count the next delivered report carries.
pub const MAX_TRACKED_FAULT_SOURCES: usize = 1_024;

/// The most reports delivered across all sources in one interval. A source beyond it is counted like one inside its own interval.
pub const MAX_FAULT_REPORTS_PER_INTERVAL: u32 = 64;

/// One report to deliver: the most recent fault of a source, and how many faults of the source were withheld since the previous report, not counting the one this report carries. A report that follows the loss of a forgotten source also carries what that source still had pending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report<T> {
    /// The source the fault is for.
    pub source: String,
    /// The fault itself, as the caller gave it.
    pub fault: T,
    /// How many faults were withheld since the last report.
    pub suppressed: u64,
}

struct Window<T> {
    /// When the window's interval began.
    since: u64,
    /// Faults of this source not yet reported, including the one `latest` carries.
    pending: u64,
    /// The most recent pending fault, which carries the count when the interval ends.
    latest: Option<T>,
    /// The order the window was set in, so the oldest can be forgotten.
    order: u64,
}

/// The reporter. `T` is what the owner wants to be told about a fault.
pub struct FaultReporter<T> {
    windows: HashMap<String, Window<T>>,
    next_order: u64,
    budget_since: Option<u64>,
    budget_used: u32,
    forgotten: u64,
}

impl<T> Default for FaultReporter<T> {
    fn default() -> Self {
        FaultReporter {
            windows: HashMap::new(),
            next_order: 0,
            budget_since: None,
            budget_used: 0,
            forgotten: 0,
        }
    }
}

impl<T> FaultReporter<T> {
    /// A reporter that has seen no fault.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes one report from the interval's budget, if it has one left.
    fn admit(&mut self, at: u64) -> bool {
        if self
            .budget_since
            .is_none_or(|since| at.saturating_sub(since) >= FAULT_REPORT_INTERVAL_MS)
        {
            self.budget_since = Some(at);
            self.budget_used = 0;
        }
        if self.budget_used >= MAX_FAULT_REPORTS_PER_INTERVAL {
            return false;
        }
        self.budget_used += 1;
        true
    }

    /// What a delivered report adds for faults of sources that were forgotten, which it takes over.
    fn take_forgotten(&mut self) -> u64 {
        std::mem::take(&mut self.forgotten)
    }

    fn forget_oldest(&mut self) {
        let Some(oldest) = self
            .windows
            .iter()
            .min_by_key(|(_, window)| window.order)
            .map(|(source, _)| source.clone())
        else {
            return;
        };
        if let Some(window) = self.windows.remove(&oldest) {
            self.forgotten += window.pending;
        }
    }

    /// Records a fault of `source` at time `at` (milliseconds from any origin, never stepping backwards). Returns the report to deliver now: this fault's own when its source is outside its interval and the budget allows, otherwise none.
    pub fn report(&mut self, at: u64, source: &str, fault: T) -> Vec<Report<T>> {
        let mut out = Vec::new();
        if let Some(window) = self.windows.get_mut(source) {
            if at.saturating_sub(window.since) < FAULT_REPORT_INTERVAL_MS {
                window.pending += 1;
                window.latest = Some(fault);
                return out;
            }
        }
        let previous = self.windows.remove(source);
        let carried = previous.as_ref().map_or(0, |window| window.pending);
        let order = self.next_order;
        self.next_order += 1;
        self.windows.insert(
            source.to_owned(),
            Window {
                since: at,
                pending: carried,
                latest: previous.and_then(|window| window.latest),
                order,
            },
        );
        if self.windows.len() > MAX_TRACKED_FAULT_SOURCES {
            self.forget_oldest();
        }
        if !self.admit(at) {
            if let Some(window) = self.windows.get_mut(source) {
                window.pending += 1;
                window.latest = Some(fault);
            }
            return out;
        }
        if let Some(window) = self.windows.get_mut(source) {
            window.pending = 0;
            window.latest = None;
        }
        let suppressed = carried + self.take_forgotten();
        out.push(Report {
            source: source.to_owned(),
            fault,
            suppressed,
        });
        out
    }

    /// The reports whose interval has ended by `at`: for each source with faults still pending, its most recent fault with the count of the others, if the budget of the interval allows, in the order the intervals ended. A report the budget refuses waits for the next interval of its source.
    pub fn due(&mut self, at: u64) -> Vec<Report<T>> {
        let mut ready: Vec<(u64, u64, String)> = self
            .windows
            .iter()
            .filter(|(_, window)| {
                window.pending > 0
                    && window.latest.is_some()
                    && at >= window.since.saturating_add(FAULT_REPORT_INTERVAL_MS)
            })
            .map(|(source, window)| {
                (
                    window.since.saturating_add(FAULT_REPORT_INTERVAL_MS),
                    window.order,
                    source.clone(),
                )
            })
            .collect();
        ready.sort();
        let mut out = Vec::new();
        for (_, _, source) in ready {
            let admitted = self.admit(at);
            let Some(window) = self.windows.get_mut(&source) else {
                continue;
            };
            window.since = at;
            if !admitted {
                continue;
            }
            let others = window.pending - 1;
            window.pending = 0;
            let Some(fault) = window.latest.take() else {
                continue;
            };
            let suppressed = others + self.take_forgotten();
            out.push(Report {
                source,
                fault,
                suppressed,
            });
        }
        out
    }

    /// How many sources have a window held now.
    #[must_use]
    pub fn tracked_sources(&self) -> usize {
        self.windows.len()
    }

    /// When the earliest held report is due, as a time on the same clock as `report` and `due`, or `None` when nothing is held. A timer set to this time and answered with [`due`](FaultReporter::due) delivers every held report at the end of its interval.
    #[must_use]
    pub fn next_due(&self) -> Option<u64> {
        self.windows
            .values()
            .filter(|window| window.pending > 0 && window.latest.is_some())
            .map(|window| window.since.saturating_add(FAULT_REPORT_INTERVAL_MS))
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn told<T: Clone>(reports: &[Report<T>]) -> Vec<u64> {
        reports.iter().map(|report| report.suppressed).collect()
    }

    #[test]
    fn a_sources_first_fault_is_delivered_at_once_and_the_ones_inside_its_interval_are_counted() {
        let mut reporter = FaultReporter::new();
        let mut all = Vec::new();
        all.extend(reporter.report(0, "peer", 1));
        all.extend(reporter.report(0, "peer", 2));
        all.extend(reporter.report(0, "peer", 3));
        all.extend(reporter.report(FAULT_REPORT_INTERVAL_MS, "peer", 4));
        assert_eq!(told(&all), vec![0, 2]);
        assert_eq!(all[1].fault, 4);
    }

    #[test]
    fn a_burst_followed_by_silence_is_told_once_its_interval_ends_how_many_were_not_reported() {
        let mut reporter = FaultReporter::new();
        let mut now = 0;
        let mut all = Vec::new();
        for fault in 0..1_000 {
            all.extend(reporter.report(now, "peer", fault));
        }
        assert_eq!(told(&all), vec![0]);
        assert_eq!(reporter.next_due(), Some(FAULT_REPORT_INTERVAL_MS));
        assert!(reporter.due(FAULT_REPORT_INTERVAL_MS - 1).is_empty());
        now = FAULT_REPORT_INTERVAL_MS;
        let late = reporter.due(now);
        // The last fault of the burst is the one the second report carries; the others in between are what it counts.
        assert_eq!(told(&late), vec![998]);
        assert_eq!(late[0].fault, 999);
        assert_eq!(reporter.next_due(), None);
    }

    #[test]
    fn one_sources_faults_do_not_hide_anothers() {
        let mut reporter = FaultReporter::new();
        let a = reporter.report(0, "a", ());
        let b = reporter.report(0, "b", ());
        assert_eq!((a.len(), b.len()), (1, 1));
    }

    #[test]
    fn the_reports_across_all_sources_in_one_interval_are_bounded() {
        let mut reporter = FaultReporter::new();
        let mut told = 0;
        for source in 0..MAX_FAULT_REPORTS_PER_INTERVAL * 2 {
            told += reporter.report(0, &source.to_string(), ()).len();
        }
        assert_eq!(told, MAX_FAULT_REPORTS_PER_INTERVAL as usize);
    }

    #[test]
    fn a_clock_that_steps_backwards_does_not_silence_every_later_fault() {
        let mut reporter = FaultReporter::new();
        let mut all = Vec::new();
        all.extend(reporter.report(10_000, "peer", ()));
        all.extend(reporter.report(5_000, "peer", ()));
        all.extend(reporter.report(10_000 + FAULT_REPORT_INTERVAL_MS, "peer", ()));
        assert!(all.len() >= 2);
    }

    #[test]
    fn the_pending_count_of_a_source_it_stopped_tracking_is_added_to_the_next_report() {
        let mut reporter = FaultReporter::new();
        let mut at = 0;
        let mut reports = Vec::new();
        reports.extend(reporter.report(at, "first", ()));
        reports.extend(reporter.report(at, "first", ()));
        // Each source arrives in an interval of its own, so the budget never refuses one; once there are more than it tracks, the oldest, "first", is forgotten with one fault still pending.
        for source in 0..=MAX_TRACKED_FAULT_SOURCES {
            at += FAULT_REPORT_INTERVAL_MS;
            reports.extend(reporter.report(at, &format!("other-{source}"), ()));
        }
        let counted: Vec<u64> = reports
            .iter()
            .filter(|report| report.source.starts_with("other-"))
            .map(|report| report.suppressed)
            .filter(|suppressed| *suppressed > 0)
            .collect();
        assert_eq!(counted, vec![1]);
    }

    #[test]
    fn the_faults_between_two_reports_are_counted_and_not_the_one_a_report_carries() {
        let mut reporter = FaultReporter::new();
        let first = reporter.report(0, "peer", "a");
        let second = reporter.report(1, "peer", "b");
        let third = reporter.report(2, "peer", "c");
        assert_eq!((first.len(), second.len(), third.len()), (1, 0, 0));
        let held = reporter.due(FAULT_REPORT_INTERVAL_MS);
        assert_eq!(held.len(), 1);
        assert_eq!((held[0].fault, held[0].suppressed), ("c", 1));
    }

    #[test]
    fn a_report_the_budget_refuses_waits_for_the_next_interval_of_its_source() {
        let mut reporter = FaultReporter::new();
        for source in 0..MAX_FAULT_REPORTS_PER_INTERVAL {
            let _ = reporter.report(0, &source.to_string(), ());
        }
        assert!(reporter.report(0, "late", ()).is_empty());
        assert_eq!(reporter.next_due(), Some(FAULT_REPORT_INTERVAL_MS));
        let due = reporter.due(FAULT_REPORT_INTERVAL_MS);
        assert_eq!(due.len(), 1);
        assert_eq!((due[0].source.as_str(), due[0].suppressed), ("late", 0));
    }
}
