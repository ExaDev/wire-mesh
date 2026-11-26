//! The peer directory a session builds from the gossip it receives, and the self-advert it sends: the mirror of the directory handling in the TypeScript `createMeshSession`.
//!
//! An advert reaching a session was very often forwarded by a hub or a gateway rather than sent by the device it names, so it is verified here, never taken on the sender's word: the identity key it carries must hash to the device it names and its signature must verify under that key ([`verify_peer_advert`]). One refused advert says nothing about the others in its frame. The newest advert per device wins, by the device's own signed `snapshot-seconds` and never by arrival, so an older advert a hub replays cannot displace a newer one; a re-advert replaces in place, so the directory keeps the order devices were first heard in.
//!
//! The directory is bounded, which the TypeScript is not: adverts come from a hub that is not trusted to bound them. At most [`MAX_DIRECTORY_DEVICES`] devices are held and no advert whose encoding is longer than [`MAX_ADVERT_BYTES`] is admitted; beyond either the advert is refused and the refusal is reported, and nothing already held is evicted (a full directory therefore stays full until the session ends, so an owner that must keep learning devices rebuilds the session or applies a policy above it), because an advert is data this node cannot ask for again and may be what it is talking to a device by.

use wire_mesh_wire::encode_frame;
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::transport::{GossipFrame, PeerAdvert};
use wire_mesh_wire::Frame;

use crate::domain::mint::MAX_EXACT_INTEGER;
use crate::domain::peer_advert::{verify_peer_advert, PeerAdvertRejection, PeerAdvertVerdict};
use crate::domain::topology::DirectoryEntry;
use crate::ports::Identity;

/// The most devices a directory holds. One entry is an advert of at most [`MAX_ADVERT_BYTES`] encoded, so a full directory is under 16 MiB, whatever a hub sends.
pub const MAX_DIRECTORY_DEVICES: usize = 1024;

/// The longest encoded advert a directory admits: 16 KiB. An honest advert is an identity key, a handful of addresses and a few small extensions (a presence status, a policy, the topology of the node), a few hundred bytes to a few kilobytes.
pub const MAX_ADVERT_BYTES: usize = 16 * 1024;

/// Why an advert did not enter the directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvertRefusal {
    /// The advert did not verify.
    Unverified(PeerAdvertRejection),
    /// Its `snapshot-seconds` is outside what a TypeScript peer holds exactly (|value| above 2^53 - 1).
    SnapshotOutOfRange,
    /// Its encoding is longer than [`MAX_ADVERT_BYTES`].
    TooLarge,
    /// The directory already holds [`MAX_DIRECTORY_DEVICES`] devices and this one is not among them.
    DirectoryFull,
}

impl AdvertRefusal {
    /// The name the conformance vectors use for this refusal.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            AdvertRefusal::Unverified(PeerAdvertRejection::WrongDevice) => "wrong_device",
            AdvertRefusal::Unverified(PeerAdvertRejection::BadSignature) => "bad_signature",
            AdvertRefusal::SnapshotOutOfRange => "snapshot_out_of_range",
            AdvertRefusal::TooLarge => "too_large",
            AdvertRefusal::DirectoryFull => "directory_full",
        }
    }
}

/// What applying one advert of a gossip frame did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdvertOutcome {
    /// The advert entered the directory, as a new device or in place of an older advert (or one of the same time).
    Admitted(DeviceId),
    /// The directory holds a newer advert for the device, so this one was ignored.
    Older(DeviceId),
    /// The advert was refused.
    Refused(DeviceId, AdvertRefusal),
}

/// The directory: the latest verified advert per device, in the order devices were first heard.
#[derive(Debug, Default)]
pub struct GossipDirectory {
    entries: Vec<DirectoryEntry>,
}

impl GossipDirectory {
    /// An empty directory.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The devices heard of and their latest advert, in first-heard order.
    #[must_use]
    pub fn entries(&self) -> &[DirectoryEntry] {
        &self.entries
    }

    /// Verifies and applies every advert of one gossip frame, in order, and returns what became of each. A refused advert is dropped alone.
    pub async fn apply(
        &mut self,
        identity: &dyn Identity,
        frame: &GossipFrame,
    ) -> Vec<AdvertOutcome> {
        let mut outcomes = Vec::with_capacity(frame.peers.len());
        for advert in &frame.peers {
            outcomes.push(self.apply_one(identity, advert).await);
        }
        outcomes
    }

    /// Applies one advert. The decisions that need no signature come first (size, snapshot range, an older advert for a known device, a full directory for an unknown one), and only an advert that would change the directory is verified: a hub that replays old adverts, or fills the directory and keeps sending new device ids, costs this node no signature check per advert. The refusal reported for a forged advert in those cases is the cheap one, which is fine since nothing from it is trusted either way.
    async fn apply_one(&mut self, identity: &dyn Identity, advert: &PeerAdvert) -> AdvertOutcome {
        let device = advert.device;
        if advert.snapshot_seconds.unsigned_abs() > MAX_EXACT_INTEGER {
            return AdvertOutcome::Refused(device, AdvertRefusal::SnapshotOutOfRange);
        }
        if encode_frame(&Frame::Gossip(GossipFrame {
            peers: vec![advert.clone()],
        }))
        .len()
            > MAX_ADVERT_BYTES
        {
            return AdvertOutcome::Refused(device, AdvertRefusal::TooLarge);
        }
        let held = self.entries.iter().position(|entry| entry.device == device);
        match held {
            Some(at) if advert.snapshot_seconds < self.entries[at].advert.snapshot_seconds => {
                return AdvertOutcome::Older(device);
            }
            None if self.entries.len() >= MAX_DIRECTORY_DEVICES => {
                return AdvertOutcome::Refused(device, AdvertRefusal::DirectoryFull);
            }
            _ => {}
        }
        if let PeerAdvertVerdict::Invalid(why) = verify_peer_advert(identity, advert).await {
            return AdvertOutcome::Refused(device, AdvertRefusal::Unverified(why));
        }
        let entry = DirectoryEntry {
            device,
            advert: advert.clone(),
        };
        match held {
            Some(at) => self.entries[at] = entry,
            None => self.entries.push(entry),
        }
        AdvertOutcome::Admitted(device)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::NodeIdentity;
    use crate::domain::self_advert::{build_self_advert, compute_topology_peers, TopologyInputs};
    use wire_mesh_wire::value::{CanonicalMap, CborValue};

    /// A time well after the earliest a self-advert accepts; the tests count seconds from it.
    const T0: u64 = 1_700_000_000;

    async fn advert_at(
        identity: &NodeIdentity,
        seconds: u64,
        extension: Option<&str>,
    ) -> PeerAdvert {
        let extensions: Vec<(String, CborValue)> = extension
            .map(|text| {
                vec![(
                    "presence/status".to_owned(),
                    CborValue::Text(text.to_owned()),
                )]
            })
            .unwrap_or_default();
        build_self_advert(
            identity,
            &[],
            T0 + seconds,
            &extensions,
            &compute_topology_peers(&TopologyInputs::default()),
        )
        .await
        .expect("an advert")
    }

    fn frame(peers: Vec<PeerAdvert>) -> GossipFrame {
        GossipFrame { peers }
    }

    #[tokio::test]
    async fn a_valid_advert_is_admitted_and_one_that_does_not_verify_is_dropped_alone() {
        let me = NodeIdentity::generate_ed25519();
        let (a, b, c) = (
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_ed25519(),
        );
        let mut directory = GossipDirectory::new();
        let good_a = advert_at(&a, 10, None).await;
        let mut wrong_device = advert_at(&b, 10, None).await;
        wrong_device.device = *c.device_id();
        let mut bad_signature = advert_at(&c, 10, None).await;
        bad_signature.signature[0] ^= 0xff;
        let outcomes = directory
            .apply(
                &me,
                &frame(vec![wrong_device, good_a.clone(), bad_signature]),
            )
            .await;
        assert_eq!(
            outcomes,
            vec![
                AdvertOutcome::Refused(
                    *c.device_id(),
                    AdvertRefusal::Unverified(PeerAdvertRejection::WrongDevice)
                ),
                AdvertOutcome::Admitted(*a.device_id()),
                AdvertOutcome::Refused(
                    *c.device_id(),
                    AdvertRefusal::Unverified(PeerAdvertRejection::BadSignature)
                ),
            ]
        );
        assert_eq!(directory.entries().len(), 1);
        assert_eq!(directory.entries()[0].advert, good_a);
    }

    #[tokio::test]
    async fn the_newest_advert_per_device_wins_in_place_and_an_older_one_is_ignored() {
        let me = NodeIdentity::generate_ed25519();
        let (a, b) = (
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_ed25519(),
        );
        let mut directory = GossipDirectory::new();
        let (first_a, first_b) = (
            advert_at(&a, 10, Some("one")).await,
            advert_at(&b, 10, None).await,
        );
        directory.apply(&me, &frame(vec![first_a, first_b])).await;
        let newer = advert_at(&a, 20, Some("two")).await;
        assert_eq!(
            directory.apply(&me, &frame(vec![newer.clone()])).await,
            vec![AdvertOutcome::Admitted(*a.device_id())]
        );
        // Replaced in place: a is still first.
        assert_eq!(directory.entries()[0].device, *a.device_id());
        assert_eq!(directory.entries()[0].advert, newer);
        // An older advert replayed by a hub does not displace it.
        let older = advert_at(&a, 15, Some("old")).await;
        assert_eq!(
            directory.apply(&me, &frame(vec![older])).await,
            vec![AdvertOutcome::Older(*a.device_id())]
        );
        assert_eq!(directory.entries()[0].advert, newer);
        // One of the same time replaces.
        let same = advert_at(&a, 20, Some("same")).await;
        assert_eq!(
            directory.apply(&me, &frame(vec![same.clone()])).await,
            vec![AdvertOutcome::Admitted(*a.device_id())]
        );
        assert_eq!(directory.entries()[0].advert, same);
        assert_eq!(directory.entries().len(), 2);
    }

    #[tokio::test]
    async fn a_snapshot_time_a_peer_cannot_hold_exactly_is_refused() {
        let me = NodeIdentity::generate_ed25519();
        let a = NodeIdentity::generate_ed25519();
        let mut advert = advert_at(&a, 10, None).await;
        advert.snapshot_seconds = i64::try_from(MAX_EXACT_INTEGER).expect("fits") + 1;
        crate::domain::peer_advert::sign_peer_advert(&a, &mut advert)
            .await
            .expect("signs");
        let mut directory = GossipDirectory::new();
        assert_eq!(
            directory.apply(&me, &frame(vec![advert])).await,
            vec![AdvertOutcome::Refused(
                *a.device_id(),
                AdvertRefusal::SnapshotOutOfRange
            )]
        );
        assert!(directory.entries().is_empty());
    }

    #[tokio::test]
    async fn an_advert_longer_than_the_cap_is_refused_and_one_at_the_cap_is_not() {
        let me = NodeIdentity::generate_ed25519();
        let a = NodeIdentity::generate_ed25519();
        let mut directory = GossipDirectory::new();
        let padded = |text: usize| {
            let a_ref = &a;
            async move {
                let mut advert = advert_at(a_ref, 10, None).await;
                advert.extra = CanonicalMap::new();
                advert
                    .extra
                    .insert("pad/x".to_owned(), CborValue::Text("x".repeat(text)))
                    .expect("unique");
                crate::domain::peer_advert::sign_peer_advert(a_ref, &mut advert)
                    .await
                    .expect("signs");
                advert
            }
        };
        // Find the text length whose advert encodes to exactly the cap.
        let measure = |advert: &PeerAdvert| {
            encode_frame(&Frame::Gossip(GossipFrame {
                peers: vec![advert.clone()],
            }))
            .len()
        };
        let base = measure(&padded(0).await);
        let fill = MAX_ADVERT_BYTES - base;
        // A text of this size has a three-byte length head, one more than the empty text's, so it adds two bytes beyond its own length.
        let at_the_cap = padded(fill - 2).await;
        assert_eq!(measure(&at_the_cap), MAX_ADVERT_BYTES);
        let over = padded(fill - 1).await;
        assert_eq!(measure(&over), MAX_ADVERT_BYTES + 1);
        assert_eq!(
            directory.apply(&me, &frame(vec![over])).await,
            vec![AdvertOutcome::Refused(
                *a.device_id(),
                AdvertRefusal::TooLarge
            )]
        );
        assert_eq!(
            directory.apply(&me, &frame(vec![at_the_cap])).await,
            vec![AdvertOutcome::Admitted(*a.device_id())]
        );
    }

    #[tokio::test]
    async fn the_directory_stops_at_its_bound_one_under_at_and_one_over_and_evicts_nothing() {
        let me = NodeIdentity::generate_ed25519();
        let mut directory = GossipDirectory::new();
        let mut first = None;
        for n in 0..MAX_DIRECTORY_DEVICES {
            let identity = NodeIdentity::generate_ed25519();
            let advert = advert_at(&identity, 10, None).await;
            if n == 0 {
                first = Some(advert.device);
            }
            assert_eq!(
                directory.apply(&me, &frame(vec![advert.clone()])).await,
                vec![AdvertOutcome::Admitted(advert.device)],
                "device {n}"
            );
        }
        assert_eq!(directory.entries().len(), MAX_DIRECTORY_DEVICES);
        let extra = NodeIdentity::generate_ed25519();
        let beyond = advert_at(&extra, 10, None).await;
        assert_eq!(
            directory.apply(&me, &frame(vec![beyond.clone()])).await,
            vec![AdvertOutcome::Refused(
                beyond.device,
                AdvertRefusal::DirectoryFull
            )]
        );
        assert_eq!(directory.entries().len(), MAX_DIRECTORY_DEVICES);
        assert_eq!(Some(directory.entries()[0].device), first);
        // A device already held can still be updated at the bound.
        let held = directory.entries()[0].advert.clone();
        assert_eq!(
            directory.apply(&me, &frame(vec![held.clone()])).await,
            vec![AdvertOutcome::Admitted(held.device)]
        );
    }

    fn forged(mut advert: PeerAdvert) -> PeerAdvert {
        advert.signature[0] ^= 0xff;
        advert
    }

    #[tokio::test]
    async fn the_decisions_that_need_no_signature_are_made_before_one_is_checked() {
        let me = NodeIdentity::generate_ed25519();
        let a = NodeIdentity::generate_ed25519();
        let mut directory = GossipDirectory::new();
        directory
            .apply(&me, &frame(vec![advert_at(&a, 20, None).await]))
            .await;
        // A forged advert older than the one held is ignored as older, without being verified.
        let older = forged(advert_at(&a, 15, None).await);
        assert_eq!(
            directory.apply(&me, &frame(vec![older])).await,
            vec![AdvertOutcome::Older(*a.device_id())]
        );
        // One that would replace the entry is verified, and is refused for its signature.
        let newer = forged(advert_at(&a, 30, None).await);
        assert_eq!(
            directory.apply(&me, &frame(vec![newer])).await,
            vec![AdvertOutcome::Refused(
                *a.device_id(),
                AdvertRefusal::Unverified(PeerAdvertRejection::BadSignature)
            )]
        );
        // A forged advert out of range or over the cap is refused for that, not for its signature.
        let mut out_of_range = forged(advert_at(&a, 10, None).await);
        out_of_range.snapshot_seconds = i64::try_from(MAX_EXACT_INTEGER).expect("fits") + 1;
        assert_eq!(
            directory.apply(&me, &frame(vec![out_of_range])).await,
            vec![AdvertOutcome::Refused(
                *a.device_id(),
                AdvertRefusal::SnapshotOutOfRange
            )]
        );
        let mut huge = advert_at(&a, 40, None).await;
        huge.extra
            .insert(
                "pad/x".to_owned(),
                CborValue::Text("x".repeat(MAX_ADVERT_BYTES)),
            )
            .expect("unique");
        assert_eq!(
            directory.apply(&me, &frame(vec![forged(huge)])).await,
            vec![AdvertOutcome::Refused(
                *a.device_id(),
                AdvertRefusal::TooLarge
            )]
        );
    }

    #[tokio::test]
    async fn a_forged_advert_for_a_new_device_meets_the_full_directory_before_its_signature_is_checked(
    ) {
        let me = NodeIdentity::generate_ed25519();
        let mut directory = GossipDirectory::new();
        for _ in 0..MAX_DIRECTORY_DEVICES {
            let identity = NodeIdentity::generate_ed25519();
            directory
                .apply(&me, &frame(vec![advert_at(&identity, 10, None).await]))
                .await;
        }
        let stranger = NodeIdentity::generate_ed25519();
        let forged_new = forged(advert_at(&stranger, 10, None).await);
        assert_eq!(
            directory.apply(&me, &frame(vec![forged_new.clone()])).await,
            vec![AdvertOutcome::Refused(
                forged_new.device,
                AdvertRefusal::DirectoryFull
            )]
        );
    }
}
