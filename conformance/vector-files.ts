// Emitting the vector files: the `write` helper and, beside it, each output file's own description, which is prose about what that file covers rather than part of any vector's definition. Split out of generate.ts, which holds the vector definitions themselves and is at this repo's own max-lines cap.

import { writeFileSync } from "node:fs";
import type { JsonWire, Vector } from "@exadev/wire-mesh-conformance";
import { introspectionFile } from "./introspection-vectors.ts";
import { roomParamsFile } from "./room-params-vectors.ts";
import { fileStorageFile } from "./file-storage-vectors.ts";
import { dataSyncFile } from "./data-sync-vectors.ts";
import { coordinatorElectionFile } from "./coordinator-election-vectors.ts";
import { invalidFrameVectors } from "./invalid-frame-vectors.ts";
import { mintFile } from "./mint-vectors.ts";
import { secureChannelFile } from "./secure-channel-vectors.ts";

const PROTOCOL_VERSION = 1;

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  "handshake.v1.json":
    "Handshake conformance vectors for protocol version 1. A conformant codec must decode each wire_hex to the described message and re-encode that message to exactly wire_hex, using RFC 8949 4.2 core deterministic (DAG-CBOR-compatible) encoding.",
  "tokens.v1.json":
    "Capability-token, room-notice, and handle-record conformance vectors for protocol version 1. Every cose-sign1 array's protected/payload byte strings are themselves canonical CBOR, decoded and re-verified the same way as any other bstr field. Signature and public-key bytes are structural placeholders (clearly-synthetic filler), not real cryptographic material -- this file freezes the byte-exact envelope shape (map key ordering, field presence, the recursive parent delegation chain), not a working signature, the same scope Cascade's own frozen vectors commit to for fields with no real crypto behind them yet. The two room-notice vectors exercise core/room's noticeboard entry schema: the first is an ordinary posted notice embedding its poster's own room:member token in full; the second forwards it, nesting the first notice's own still-independently-verifiable room-notice as its content with a content-type naming it as such, and a refs entry with relation \"forward\" pointing at the original notice-id.",
  "adverts.v1.json":
    "peer-advert conformance vectors for protocol version 1, the one file here built on real Ed25519 key material rather than structural filler. Beyond the usual wire_hex round trip, each vector records signing_input_hex (spec/transport.cddl's domain-separation context followed by the canonical CDE encoding of the advert with its signature entry removed) and the verdict `verifies` a conformant verifier must reach, applying both the self-certification check and the signature check. An implementation that reconstructs the signing input even one byte differently will reject every advert another implementation sends while still passing its own tests, which is exactly what freezing these bytes catches. The key is derived from a fixed seed and the algorithm is Ed25519 specifically because its signatures are deterministic (RFC 8032), so regenerating this file reproduces it byte for byte.",
  "secure-channel.v1.json":
    "Secure-channel conformance vectors for protocol version 1: the handshake, key schedule and sealing of spec/secure-channel.cddl, on real key material that is made up for these vectors and is test material only. The top-level vectors are every hello and every sealed secure-data frame, round-tripped like any other vector file. The secure_channel section adds what a round trip cannot: for each handshake the fixed ephemeral keys and nonces, each hello's signing input and signature, the shared secret, salt, HKDF info and both direction keys, and a transcript of sealed frames with each IV, associated data and ciphertext; the verdict a receiver gives for each hello (ok, or the reason it is refused: wrong_recipient, unsupported_identity_alg, invalid_identity_key or bad_signature, checked in the order the spec states); the establish verdicts for ephemeral keys that cannot be used; and sequences of secure-data frames to open in order, each step with the result a conformant channel must give (an opened frame, replayed, unauthentic or undecodable), including counters up to 2^64 - 1 that a narrower implementation must refuse and not truncate. Every key and identity in the file is made up for it and marked synthetic. Ed25519 signatures and AES-GCM are deterministic, so regenerating reproduces them byte for byte. ES256 signatures are not: such a hello is verify-only, its signature is emitted once and kept on regeneration while its signing input is unchanged, and an implementation checks it verifies and never expects to reproduce it.",
  "mint.v1.json":
    "Capability-token, revocation-entry and room-notice minting vectors for protocol version 1: the exact bytes a conformant minter produces from fixed Ed25519 identities (whose signatures are deterministic), the refusal reason of every rule a delegation or an authorised-by mint can break, and the verdicts of the pure queries canGrant and canGrantVia. The top-level vectors are every minted token and revocation entry, round-tripped like any other file; the `mint` section holds the inputs of each case and what it must produce. Each identity is made up for these vectors and is test material only.",
  "invalid-frames.v1.json":
    "Values outside the grammar of the spec's `.regexp` patterns, for protocol version 1. The control matches the whole string, so a conformant decoder refuses every vector here, at decoding or at validation: a capability verb with two colons, a trailing space or newline or a leading hyphen, a domain with trailing text, a trailing newline or an embedded separator, and the three verb fields of token claims. Each vector is well-formed CBOR in the shape of a valid frame (kind frame) or token-claims map (kind token-claims) with one such value, carries refused: true and the CDDL rule it breaks, and carries valid_control_wire_hex, the same bytes with a value inside the grammar, which every consumer must accept so that a vector cannot be refused for another reason. message and wire_hex follow the shared round-trip contract. The room-path and device-id-hex patterns occur only in the room-notice claims, which the implementations' own schema and parser tests pin.",
  "coordinator-election.v1.json":
    "Coordinator-election vectors for protocol version 1 (coordinator-frame in spec/transport.cddl). The top-level vectors are the claims gossiped, round-tripped like any other file. The `coordinator_election` section holds scenarios, each a side that has made and heard no claim followed by steps (evaluating a frame heard, making a claim, re-announcing the incumbent) with what each returns and the state after it, and the pure rules on their own: which terms a later claim can supersede and the order of device-ids. A strictly higher term wins, an equal term goes to the lowest device-id, a lower term loses, and a term of 2^53 - 1 or over is dropped unevaluated. Device-ids are structural bytes, not hashes of keys. The outcomes are written by hand from the spec, never produced by an implementation.",
  "data-sync.v1.json":
    "core/data sync vectors for protocol version 1 (spec/data-domain.cddl). The top-level vectors are the have, request and entries frames the scenarios use, round-tripped like any other file. The `data_sync` section holds scenarios over a key-value store: each starts from a store (key and value in hex) and runs steps (head_seq_for, append_own_entry, handle_data_have, handle_data_request, handle_data_entries, read_entries), each recording what it returns and the whole store after it. The log layout is part of the contract: data/<device-id-hex>/head holds the head as decimal text and data/<device-id-hex>/entry/<seq> one entry, so a store written by one implementation is read by the other. The outcomes are written by hand from the spec, never produced by an implementation. Device-ids are structural bytes, not hashes of keys.",
  "file-storage.v1.json":
    "File-backed key-value storage vectors for protocol version 1: the layout both implementations' file storage shares. There are no wire vectors. The `file_storage` section holds `key_layout`, which gives for each key the path of the file that holds it or the reason the layout refuses it (an empty key, a NUL, a backslash, a leading slash, an empty, `.` or `..` segment), and `scenarios`, which start from a directory (every file under it as a `/`-joined path with its content in hex), run operations on a storage over a copy of it, and record what each returns and the whole directory after it. A value is the whole content of its file, nothing added. The outcomes are written by hand from the layout, never produced by an implementation.",
  "room-params.v1.json":
    "Typed core/room and capability vectors for protocol version 1 (spec/room.cddl, spec/management.cddl). The top-level vectors are manage-request and manage-response frames carrying room.send, room.read, room.leave, room.invite and capability.request params and room-join-ok, room-members-ok and capability-grant-ok outcomes, round-tripped like any other file. The `room_params` section gives, for each frame, the shape a typed decoder must read it as and the value of every field and the keys of its open tail; a list of frames each breaking one rule of a shape, which a typed decoder must refuse, each naming the valid vector it varies; and the cases of the room-path and hex helpers. Every outcome is written by hand from the spec, never produced by an implementation. Device-ids and tokens are structural bytes.",
  "introspection.v1.json":
    "core/management introspection vectors for protocol version 1 (spec/management.cddl): path:trace and topology.get. The top-level vectors are the manage-request and manage-response frames the cases use and gossip frames each holding one peer-advert, round-tripped like any other file. The `introspection` section gives, for each frame, the shape a typed decoder must read it as and every field; frames each breaking one rule of a shape, which a typed decoder must refuse; the answer built for a path.trace; traces run against a scripted peer and clock; the topology read from an advert's `topology/peers` extension; the graph assembled from a directory; and topology.get run against a scripted peer. Every outcome is written by hand from the spec, never produced by an implementation. Device-ids, keys and signatures are structural bytes and the adverts are not verified.",
  "frames.v1.json":
    "Frame conformance vectors for protocol version 1, covering every $frame-variant in spec/frame.cddl except handshake-frame (see handshake.v1.json). manage-response-frame gets two vectors, one per branch of its manage-ok / manage-error outcome union. The four core/webrtc vectors (offer, answer, ice-candidate, end-of-candidates) exercise manage-request-frame's params socket with new content, not a new frame kind; the offer vector is also the first in this file to exercise manage-request-frame's optional token field. The core/room vectors (send with sent-at/content-type/a reply ref, batched read, leave, members, invite carrying its own pushed grant) carry the room:member token from tokens.v1.json's own root grant; the join vector is the first in this file to exercise an ungated manage-request (no token field at all). room-join-ok and room-members-ok are this domain's own named manage-ok variants (a minted grant plus membership, and a plain membership refresh, respectively), not the generic `* tstr => any` tail alone.",
};

function write(
  filename: string,
  vectors: readonly Vector[],
  extra: Readonly<Record<string, JsonWire>> = {},
): void {
  const description = DESCRIPTIONS[filename];
  if (description === undefined) {
    throw new Error(`no description recorded for ${filename}`);
  }
  const content = {
    protocol_version: PROTOCOL_VERSION,
    description,
    vectors,
    ...extra,
  };
  writeFileSync(
    new URL(filename, import.meta.url),
    JSON.stringify(content, null, 2) + "\n",
  );
  console.log(`wrote ${filename} (${String(vectors.length)} vectors)`);
}

/** Writes every vector file, in the order a reader of conformance/README.md meets them. */
export function writeVectorFiles(
  files: Readonly<{
    handshake: readonly Vector[];
    tokens: readonly Vector[];
    adverts: readonly Vector[];
    frames: readonly Vector[];
  }>,
): void {
  write("handshake.v1.json", files.handshake);
  write("tokens.v1.json", files.tokens);
  write("adverts.v1.json", files.adverts);
  write("frames.v1.json", files.frames);
  write("invalid-frames.v1.json", invalidFrameVectors);
  const secureChannel = secureChannelFile(files.frames);
  write("secure-channel.v1.json", secureChannel.vectors, secureChannel.extra);
  const mint = mintFile();
  write("mint.v1.json", mint.vectors, mint.extra);
  const election = coordinatorElectionFile();
  write("coordinator-election.v1.json", election.vectors, election.extra);
  const dataSync = dataSyncFile();
  write("data-sync.v1.json", dataSync.vectors, dataSync.extra);
  const fileStorage = fileStorageFile();
  write("file-storage.v1.json", fileStorage.vectors, fileStorage.extra);
  const roomParams = roomParamsFile();
  write("room-params.v1.json", roomParams.vectors, roomParams.extra);
  const introspection = introspectionFile();
  write("introspection.v1.json", introspection.vectors, introspection.extra);
}
