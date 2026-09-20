// Emitting the vector files: the `write` helper and, beside it, each output file's own description, which is prose about what that file covers rather than part of any vector's definition. Split out of generate.ts, which holds the vector definitions themselves and is at this repo's own max-lines cap.

import { writeFileSync } from "node:fs";
import type { Vector } from "@exadev/wire-mesh-conformance";

const PROTOCOL_VERSION = 1;

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  "handshake.v1.json":
    "Handshake conformance vectors for protocol version 1. A conformant codec must decode each wire_hex to the described message and re-encode that message to exactly wire_hex, using RFC 8949 4.2 core deterministic (DAG-CBOR-compatible) encoding.",
  "tokens.v1.json":
    "Capability-token, room-notice, and handle-record conformance vectors for protocol version 1. Every cose-sign1 array's protected/payload byte strings are themselves canonical CBOR, decoded and re-verified the same way as any other bstr field. Signature and public-key bytes are structural placeholders (clearly-synthetic filler), not real cryptographic material -- this file freezes the byte-exact envelope shape (map key ordering, field presence, the recursive parent delegation chain), not a working signature, the same scope Cascade's own frozen vectors commit to for fields with no real crypto behind them yet. The two room-notice vectors exercise core/room's noticeboard entry schema: the first is an ordinary posted notice embedding its poster's own room:member token in full; the second forwards it, nesting the first notice's own still-independently-verifiable room-notice as its content with a content-type naming it as such, and a refs entry with relation \"forward\" pointing at the original notice-id.",
  "adverts.v1.json":
    "peer-advert conformance vectors for protocol version 1, the one file here built on real Ed25519 key material rather than structural filler. Beyond the usual wire_hex round trip, each vector records signing_input_hex (spec/transport.cddl's domain-separation context followed by the canonical CDE encoding of the advert with its signature entry removed) and the verdict `verifies` a conformant verifier must reach, applying both the self-certification check and the signature check. An implementation that reconstructs the signing input even one byte differently will reject every advert another implementation sends while still passing its own tests, which is exactly what freezing these bytes catches. The key is derived from a fixed seed and the algorithm is Ed25519 specifically because its signatures are deterministic (RFC 8032), so regenerating this file reproduces it byte for byte.",
  "frames.v1.json":
    "Frame conformance vectors for protocol version 1, covering every $frame-variant in spec/frame.cddl except handshake-frame (see handshake.v1.json). manage-response-frame gets two vectors, one per branch of its manage-ok / manage-error outcome union. The four core/webrtc vectors (offer, answer, ice-candidate, end-of-candidates) exercise manage-request-frame's params socket with new content, not a new frame kind; the offer vector is also the first in this file to exercise manage-request-frame's optional token field. The core/room vectors (send with sent-at/content-type/a reply ref, batched read, leave, members, invite carrying its own pushed grant) carry the room:member token from tokens.v1.json's own root grant; the join vector is the first in this file to exercise an ungated manage-request (no token field at all). room-join-ok and room-members-ok are this domain's own named manage-ok variants (a minted grant plus membership, and a plain membership refresh, respectively), not the generic `* tstr => any` tail alone.",
};

function write(filename: string, vectors: readonly Vector[]): void {
  const description = DESCRIPTIONS[filename];
  if (description === undefined) {
    throw new Error(`no description recorded for ${filename}`);
  }
  const content = { protocol_version: PROTOCOL_VERSION, description, vectors };
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
}
