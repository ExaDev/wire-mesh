# Core capability registry

Append-only. A bare `subsystem:action` capability verb is spec-owned and matched by `tokens.cddl`'s `core-capability` rule. An entry is never renumbered or reused; a capability no longer in active use is marked retired here, not removed.

| Capability | Scope kind | Domain | Status |
|---|---|---|---|
| `pin:write` | `folder` | `core/management` | active |
| `exec:pty` | `folder` | `core/exec` | active |
| `exec:proc` | `folder` | `core/exec` | active |
| `webrtc:signal` | `node` | `core/webrtc` | active |

Third parties do not add entries here — see `namespaced-capability` in `tokens.cddl` for the registrant-owned namespace anyone else uses instead.
