// The trust-on-first-use decision for a node served over WebTransport, kept pure so the rules can be tested without a session. An address that carries certificate pins is the first time this console is told what a node's certificate is; `certificate-memory.ts` holds what it has been told since. The decision compares the two.

import { bytesToHex } from "wire-mesh-core/domain/device-id";
import {
  isPinnedAddress,
  parsePinnedAddress,
} from "wire-mesh-core/domain/pinned-address";
import type { CertificateMemory } from "./certificate-memory.js";

/**
 * What an address's certificate pins say about the node, against what is remembered for it.
 * - `first-use`: nothing is remembered, so the user decides whether to trust these certificates.
 * - `known`: at least one presented certificate is one already remembered, which is how a rotation looks, since a node always announces the certificate it serves now beside the ones it will serve next. `trusted` is the presented certificates that are remembered: the only ones the address may be dialled with, since a presented certificate that is not remembered has not been approved by anyone.
 * - `changed`: something is remembered and none of it is presented, which is what a different node behind the same address, or a replaced certificate, looks like.
 */
export type CertificateAssessment =
  | { kind: "first-use"; node: string; presented: readonly string[] }
  | { kind: "known"; node: string; trusted: readonly string[] }
  | {
      kind: "changed";
      node: string;
      remembered: readonly string[];
      presented: readonly string[];
    };

export function assessCertificates(
  node: string,
  presented: readonly string[],
  remembered: readonly string[],
): CertificateAssessment {
  if (remembered.length === 0) {
    return { kind: "first-use", node, presented };
  }
  const known = new Set(remembered);
  const trusted = presented.filter((hash) => known.has(hash));
  if (trusted.length > 0) {
    return { kind: "known", node, trusted };
  }
  return { kind: "changed", node, remembered, presented };
}

/** The certificate pins an address presents, with the node (`host:port`) they are for, or undefined for an address that has none to trust: one that is not pinned, or whose pins are malformed. */
export function presentedCertificates(
  address: string,
): { node: string; sha256: Uint8Array<ArrayBuffer>[] } | undefined {
  if (!isPinnedAddress(address)) {
    return undefined;
  }
  try {
    const { url, sha256 } = parsePinnedAddress(address);
    return { node: new URL(url).host, sha256: [...sha256] };
  } catch {
    // Malformed pins are not something to trust or remember. The dial that follows rejects the address with the parser's own message, which the connection's status line reports.
    return undefined;
  }
}

/** A node's announced certificates that share nothing with what was remembered for it. The session was authenticated by a certificate this console had pinned, so the node is reachable, but it has stopped serving anything this console had been told to expect. */
export interface CertificateChange {
  node: string;
  remembered: readonly string[];
  presented: readonly string[];
}

/**
 * A memory that reports every `remember` which replaces a non-empty set with a disjoint one. The write still happens: the announcement arrived on a session this console had already pinned, so it is authentic, but the change is not something to apply silently.
 */
export function observeCertificateChanges(
  memory: Readonly<CertificateMemory>,
  onChange: (change: Readonly<CertificateChange>) => void,
): CertificateMemory {
  return {
    recall: memory.recall,
    remember: async (node, hashes) => {
      const assessment = assessCertificates(
        node,
        hashes.map((hash) => bytesToHex(hash)),
        (await memory.recall(node)).map((hash) => bytesToHex(hash)),
      );
      await memory.remember(node, hashes);
      if (assessment.kind === "changed") {
        onChange({
          node,
          remembered: assessment.remembered,
          presented: assessment.presented,
        });
      }
    },
  };
}

const HEX_DIGITS_PER_BYTE = 2;

/** A certificate hash as browsers and `openssl x509 -fingerprint` show it, uppercase hex pairs separated by colons, so a person can compare it against what the node's operator reads out. */
export function formatFingerprint(sha256Hex: string): string {
  const pairs: string[] = [];
  for (let index = 0; index < sha256Hex.length; index += HEX_DIGITS_PER_BYTE) {
    pairs.push(
      sha256Hex.slice(index, index + HEX_DIGITS_PER_BYTE).toUpperCase(),
    );
  }
  return pairs.join(":");
}
