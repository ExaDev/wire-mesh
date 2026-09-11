# Core domain registry

Append-only. A `core/*` domain name is spec-owned and defined in `handshake.cddl`'s `core-domain-name` rule. An entry is never renumbered or reused; a domain no longer in active use is marked retired here, not removed.

| Domain | Defined in | Status |
|---|---|---|
| `core/management` | `management.cddl` | active |
| `core/exec` | `exec.cddl` | active |
| `core/data` | `data-domain.cddl` | active |
| `core/federation` | `federation.cddl` | retired — no frames defined; cross-scope sharing now uses ordinary capability tokens (`tokens.cddl`) and discovery (`discovery.cddl`) instead |
| `core/webrtc` | `webrtc.cddl` | active |
| `core/room` | `room.cddl` | active |

Third parties do not add entries here — see `namespaced-domain-id` in `handshake.cddl` for the registrant-owned namespace anyone else uses instead.
