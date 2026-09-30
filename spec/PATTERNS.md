# Patterns

Compositions of mechanisms this spec already defines, written down because they are recommended ways to build on the protocol rather than new wire structures. Where `CONVENTIONS.md` collects idioms a schema author should check before inventing a new one, this file collects compositions an application author should check before designing a new mechanism: if the outcome you want is one of these, the frames and domains below already cover it.

## The replicated issuer grant ledger

An issuer (a user principal, a room owner, any key that mints capability tokens) needs to remember what it granted so it can revoke a specific grant later. `tokens.cddl`'s own design makes this a real obligation rather than bookkeeping nicety: a token-id never appears on the wire except inside the grant it names, so the only record that grant X ever existed is whatever the issuer itself kept. An issuer whose key material lives on one device therefore has a ledger that exists in exactly one place, and revocation is impossible from anywhere else: an issuer split across several machines (an account key copied deliberately, say) has several ledgers, each blind to the grants the others minted.

The pattern: keep the issuer's ledger as entries in the issuer's own `core/data` log (`data-domain.cddl`), one entry per minted grant carrying at least the token-id and the grant's parameters, and one entry per revocation carrying the token-id being revoked and the revocation entry itself. Everything then falls out of mechanisms this spec already defines:

- Replication is data-domain fan-out, nothing new. Every device replicating the issuer's log holds the complete ledger, and any replicant can answer `data-have`/`data-request` for it on the issuer's behalf (the `peer` field is a plain reference, so a replicator answers for the replicated peer already).
- Revocation from any machine holding the issuer key is appending to the same single-writer log the grant was recorded in: no merge, no conflict, and every replicant sees the revocation exactly as it sees the grants. Consumers feed each revocation entry into the same `RevocationView` verification a locally minted revocation already uses.
- Durability is the owner-initiated push `data-domain.cddl` already recommends: an issuer wanting its ledger to survive a lost device proactively replicates it to its own `discovery.cddl` mailboxes.

Two boundaries keep the pattern honest. Writing (minting, revoking) still requires the issuer's private key, always: replication moves the ledger's bytes, never the authority to append to it, so a replicated ledger on a thousand devices grants none of them the power to mint. And the ledger's confidentiality is the application's own choice: `core/data` entries are opaque bytes to the transport, so an issuer that wants grant records private to its own devices encrypts the entry payload the way `secure-channel.cddl` protects any other application content, at the application layer, with no wire change.

First consumer: agent-comms's portable account (`agent-comms#344`), whose user principal's `issuedDeviceGrants` ledger becomes a replicated log so any machine holding the account key can revoke what any other minted.
