# WebTransport binding

How a client reaches a node over [WebTransport](https://www.w3.org/TR/webtransport/) without a certificate authority, and how frames travel once it has. The frames themselves are the ones defined in the CDDL files here; this file specifies only what a WebTransport transport adds around them.

## Address

A node advertises `https://<host>:<port>#sha256=<hex>[,<hex>...]`: where to connect, and the SHA-256 hash (64 lowercase hex digits) of each certificate the node serves now or will serve next, in the order they take over. A client passes every hash as a `serverCertificateHashes` entry and accepts the node's certificate if it matches any of them. The address carries its own trust: no certificate authority and no name resolution are involved, so it works where neither is available.

A certificate pinned this way must be valid for less than two weeks. A node therefore serves a rolling schedule of certificates, each taking over half a lifetime after the one before it, and lists the serving certificate and the next ones in the address, so an address stays usable until every certificate it lists has finished serving. A client that outlasts that is given the current list by the node (see Announcement) and dials with it.

## Session and stream

A client opens a session at the path `/wire-mesh` and then opens one bidirectional stream, on which the whole connection runs. Frames are length-prefixed: a 4-byte big-endian length, then that many bytes of the frame's CBOR encoding. A frame whose length exceeds the receiver's limit fails the connection. A length of zero is a marker with no frame in it, skipped by the receiver: a QUIC stream is invisible to its peer until a byte crosses it, so the side that opens the stream writes one before it has a real frame.

## Announcement

When a session is accepted, the node opens a unidirectional stream to the client and writes one CBOR map, then closes the stream: `{ "sha256": [ <32-byte string>, ... ] }`, the hashes the node serves now and will serve next, in the order they take over, between one and eight of them. It is authentic because it arrives on the session the client pinned, so it carries no signature. A client remembers the latest announcement for the node, pins it together with the hashes in the address on its next dial, and redials with it. A node that sends none, or one a client cannot read, leaves the address as it was given.

## Rotation

The node cannot change the certificate a running server presents, so it rotates by replacing the server on the same port. It drains the old one first: sessions that arrive during the drain are closed at once, open sessions are closed with a close the client receives (code 0, reason `certificate rotated`), and only then is the server stopped. A client whose session closes reconnects over the same address, which by construction lists the certificate now being served.
