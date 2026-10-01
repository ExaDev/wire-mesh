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
| `manage:grant` | any — must narrow the minted token's own scope; `grants-capability` names the verb it may mint (absent: any) | `core/management` | active |
| `bulk:write` | any — left open to the calling domain (e.g. `folder` for a `core/exec` stdout capture) | `core/bulk` | active |
| `bulk:read` | any — left open to the calling domain | `core/bulk` | active |
| `group:member` | `group` | `core/management` | active |
| `path:trace` | `node` — carried but never checked; path.trace verifies no scope or token at all | `core/management` | active |
| `topology:get` | `node` | `core/management` | active |

`manage:<authority>` is the convention for authority over tokens themselves (`manage:revoke`, `manage:grant`): the verb names the authority, and the token's `<authority>-capability` claim (`grants-capability`) names the verb that authority is over.

Third parties do not add entries here — see `namespaced-capability` in `tokens.cddl` for the registrant-owned namespace anyone else uses instead. `path:trace` and `topology:get` are both deliberately ungated, the same as `room:join`/`room:invite` above — see `management.cddl`'s own `path-trace`/`topology-get` comments for why.
