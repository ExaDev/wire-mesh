import {
  decodeCertificateHashes,
  encodeCertificateHashes,
} from "wire-mesh-core/domain/pinned-address";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";

const KEY_PREFIX = "pinned-certificates/";

/** The certificate hashes a node last announced, kept per node so a console that reopens later can still reach a node whose address it was given before the node's certificates changed. */
export interface CertificateMemory {
  /** The hashes last remembered for `node` (its `host:port`), or none. */
  recall: (node: string) => Promise<Uint8Array<ArrayBuffer>[]>;
  /** Replaces what is remembered for `node`. */
  remember: (
    node: string,
    hashes: readonly Uint8Array<ArrayBuffer>[],
  ) => Promise<void>;
}

export function createCertificateMemory(
  storage: Readonly<KeyValueStorage>,
): CertificateMemory {
  return {
    recall: async (node) => {
      const stored = await storage.get(KEY_PREFIX + node);

      return stored === undefined ? [] : decodeCertificateHashes(stored);
    },
    remember: async (node, hashes) => {
      const encoded = encodeCertificateHashes(
        hashes.map((hash) => bytesToHex(hash)),
      );
      await storage.set(KEY_PREFIX + node, new Uint8Array(encoded));
    },
  };
}
