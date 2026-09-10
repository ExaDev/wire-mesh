// A minimal async key/value contract for whatever this package needs to persist (revocation entries, data-domain oplog entries) -- local and remote implementations interchangeable behind it, per the org's storage-boundary rules. Values are opaque bytes, not a specific serialisation: callers encode/decode with whatever schema the stored data actually has (a revocation-entry, a data-domain entry, etc.), matching the protocol's own treatment of data-domain entries as opaque to the wire format.
export interface KeyValueStorage {
  get: (key: string) => Promise<Uint8Array | undefined>;
  set: (key: string, value: Uint8Array) => Promise<void>;
  delete: (key: string) => Promise<void>;
  /** Keys with the given prefix, in no particular order. */
  keys: (prefix: string) => Promise<string[]>;
}
