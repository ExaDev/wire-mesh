# Spec-wide conventions

A handful of idioms have been independently reinvented more than once while extending this spec, each time because there was no standing convention to reach for. This file collects them so a future domain author defaults to one deliberately, rather than re-deriving it from first principles a third or fourth time. None of these is enforced by CDDL itself — every one is a verifier or author obligation, the same category of thing `tokens.cddl`'s narrowing rule already is.

## Deterministic tiebreak for equal-rank claims

When two peers make an equal-rank claim at the same moment and something has to pick a single winner without a synchronous vote, break the tie on the lowest device-id.

`coordinator-frame`'s own coordinator-election rule is the canonical instance: two peers claiming coordinator at the same `term` are broken by lowest device-id (`transport.cddl`), not by wall-clock arrival order, which is exactly the kind of thing a distributed system can't observe consistently. `core/room`'s noticeboard entries need the identical property for a different reason — there is no single shared log to order cross-author notices by a plain sequence number, so `room.cddl` sorts by `(posted-at, poster, notice-id)`, where `poster` (a device-id) is the same deterministic tiebreak for two notices that land at the same `posted-at`.

**Convention**: when a future domain needs to deterministically resolve a tie between two peers with no shared authority to ask, sort by device-id (or a tuple that ends in device-id, if a coarser primary key exists first) rather than inventing a new tiebreak rule. It requires no coordination, no clock, and no state beyond what both sides already have.

## A canonical correlation-id: `session-id`

A multi-message exchange within one connection needs its own correlation field, distinct from `manage-request-frame`'s own `request-id` (which only correlates a single RPC round trip — the ack that one specific request was received, not the multi-message exchange it might be one step of).

`core/webrtc`'s `negotiation-id` is the existing, shipped instance: chosen by the offering side, echoed by the answering side, so one connection can host more than one concurrent or superseding SDP negotiation without the offer/answer/candidate* messages being ambiguous about which exchange they belong to (`webrtc.cddl`). A future multi-round domain needing the identical structural role — most concretely, `core/threshold`'s own planned `signing-id`/`keygen-id` correlating a FROST signing or DKG round's multiple `manage-request`/`manage-response` round trips — should not mint its own name for this.

**Convention**: name the field `session-id: uint` (not `negotiation-id`, `signing-id`, `keygen-id`, or any other domain-specific synonym), chosen by whichever side initiates the multi-round exchange and echoed by the other side on every message that belongs to it. `negotiation-id` predates this convention and is not being renamed retroactively — renaming a shipped, conformance-pinned field for a naming convention alone is not worth the churn — but every future multi-round domain should reach for `session-id` from the start.

## The facilitator role

A facilitator is a role trusted only for reachability or routing, never for the correctness of what it facilitates, and always replaceable without weakening whatever guarantee the domain around it actually provides.

Two shipped instances:

- **`relay-hub`** (the `relay-offer`/`relay-connect`/`relay-data`/`relay-inbound` frames, `transport.cddl`): forwards an opaque, unreadable byte pipe between two peers that can't connect directly. "The relay never holds the keys to decrypt what it forwards" is stated directly in the frame's own comment — a relay that goes down, misbehaves, or is swapped for a different one changes nothing about the end-to-end guarantee the two peers' own encryption already provides.
- **`discovery.cddl`'s `mailboxes`**: relay/hub devices holding a peer's `core/data` entries on its behalf while it's offline, named in the plural specifically so no single mailbox is essential — losing one costs reachability while that peer is offline, never correctness, and the owner is never dependent on any one mailbox's uptime.

Two more instances are designed but not yet shipped (`core/threshold`'s own signing **coordinator** — "untrusted for security, trusted only for liveness; any participant may coordinate, a stalled session recovers by another device starting fresh" — and the same coordinator role reused as a threshold-signing group's live network front, so the group can answer handshake/gossip/connections without that costing it any signing authority), named here so the pattern is recognisable the moment that domain lands, not rediscovered a fifth time.

**Convention**: when a domain needs something in the middle that never needs to be trusted with the content or the correctness of what passes through it — only with getting it there, or with being reachable when the real participant currently isn't — reach for this pattern by name rather than inventing bespoke trust language for it. The test for "is this actually a facilitator": is it fully interchangeable with another instance of the same role with zero loss of the guarantee the domain provides? If yes, it's a facilitator; if replacing it would actually weaken something, it's a participant, not a facilitator, and needs to be modelled (and trusted) as one.

## Verifier obligations, collected

A verifier obligation is a rule CDDL's own grammar cannot express — it constrains what a conformant implementation must check at runtime, not what a message may contain. These are scattered across per-domain comments; collected here so a new domain's own author checks against one list rather than re-deriving what a careful verifier obligation looks like from nothing.

- **Narrowing.** A delegated capability-token's own claims (`capability`, `scope`) MUST only ever narrow what its parent grants, never widen it, and a child's `expires` MUST be clamped to (never later than) its parent's (`tokens.cddl`).
- **`delegations-remaining` MUST strictly decrease.** A child token's own `delegations-remaining`, if present, MUST be strictly less than its parent's. Absent means unbounded — every token minted before this claim existed keeps its exact current meaning.
- **Full ancestor-chain revocation walk, not just the leaf.** A verifier walking a token's `parent` chain MUST check every ancestor's own `token-id` against the revocation view, not only the token actually being presented — revoking one ancestor revokes everything delegated beneath it (`management.cddl`, `tokens.cddl`).
- **A revocation is only valid from the token's own issuer.** A verifier MUST check `revocation-claims.issuer` against the *token's own* issuer field, not merely that some signature verifies — only a token's own issuer may revoke it (`management.cddl`).
- **Self-certification.** Anywhere an embedded `identity-key`/`issuer-key`/`poster-key` accompanies a device-id (`token-claims`, `revocation-claims`, `handle-claims`, `room-notice-claims`), a verifier MUST check `sha256(embedded-key.public-key) == the claimed device-id` before trusting anything else about the payload.
- **Bearer MUST match the authenticated identity actually presenting the claim.** For a live request this means the peer authenticated on the connection it arrived on (never a routing hint a relay merely asserts, which is untrusted by construction); for a self-certifying entry with no connection to bind to (`core/room`'s noticeboard entries), the entry's own signature carries that binding instead — a verifier checks the token's own `bearer` field against the entry's own claimed author directly (`room.cddl`).
- **An unrecognised value in an open discriminator MUST be refused or ignored, never acted on.** `capability-scope.kind`, `room-notice-claims.content-type`, and (once `core/threshold` lands) `threshold-subject.kind` are all deliberately open `tstr` fields (see below) precisely so a new value is forward-compatible — but a verifier that doesn't recognise a specific value cannot meaningfully review or act on the content it gates, so it MUST refuse rather than proceed blindly. This is the general "don't trust what you can't understand" obligation an open discriminator's own flexibility requires as its counterpart.

## Open `tstr` discriminators over closed enums

When a field's set of possible values is expected to grow as new domains adopt the same structure, model it as an open `tstr` (any string satisfying some pattern, or none at all) rather than a closed enum of literal values, even though a closed enum looks like better validation today.

Two shipped instances: `capability-scope.kind` (`tokens.cddl`) — "node" and "folder" are Cascade's own scopes, "room"/"org" are agent-comms', "group" is a person's/team's/organisation's own device set, and the comment states plainly that "a future application mints its own kind rather than needing this schema to change." `message-ref.relation` (`room.cddl`) — "reply" and "forward" are the two relations needed today, but the field is an open `tstr` specifically so a future relation (quote, edit-of, supersedes) is an additive value, never a schema change.

Two further instances are anticipated, not yet shipped: a `peer-advert` extension bag (mirroring `token-claims`' own `* tstr => any` tail, proposed so presence status, a peer's own accept/refuse policy, and future gossiped facts share one open extension point rather than each becoming its own bolted-on field) and `core/threshold`'s own `threshold-subject.kind` (the type of content a threshold signature covers) — named here so whoever builds either reaches for an open field from the start rather than shipping a closed enum and having to widen it later.

**Convention**: before adding a closed enum for any field that names a *kind* of something (a scope kind, a relation, a content type, a subject type), ask whether a future domain might reasonably need a value this spec doesn't anticipate. If yes — which is the common case for anything describing "what kind of X is this" rather than a truly fixed, small, protocol-level choice — use an open `tstr` (optionally pattern-constrained) instead, and pair it with the verifier obligation above: an unrecognised value must be refused, never guessed at.
