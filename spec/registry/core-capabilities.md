# Core capability registry

Append-only. A bare `subsystem:action` capability verb is spec-owned and matched by `tokens.cddl`'s `core-capability` rule. An entry is never renumbered or reused; a capability no longer in active use is marked retired here, not removed.

| Capability | Scope kind | Domain | Status |
|---|---|---|---|
| `pin:write` | `folder` | `core/management` | active |
| `exec:pty` | `folder` | `core/exec` | active |
| `exec:proc` | `folder` | `core/exec` | active |
| `webrtc:signal` | `node` | `core/webrtc` | active |
| `room:member` | `room` | `core/room` | active |
| `room:join` | `room` | `core/room` | active |
| `room:invite` | `room` | `core/room` | active |
| `relay:use` | `node` | `core/management` | active |
| `manage:revoke` | any — narrows to the target token's own scope kind | `core/management` | active |
| `bulk:write` | any — left open to the calling domain (e.g. `folder` for a `core/exec` stdout capture) | `core/bulk` | active |
| `bulk:read` | any — left open to the calling domain | `core/bulk` | active |
| `group:member` | `group` | `core/management` | active |
| `path:trace` | `node` — carried but never checked; path.trace verifies no scope or token at all | `core/management` | active |

Third parties do not add entries here — see `namespaced-capability` in `tokens.cddl` for the registrant-owned namespace anyone else uses instead.
