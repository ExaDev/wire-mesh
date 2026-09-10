//#region src/ports/storage.d.ts
export interface KeyValueStorage {
  get: (key: string) => Promise<Uint8Array | undefined>;
  set: (key: string, value: Uint8Array) => Promise<void>;
  delete: (key: string) => Promise<void>;
  /** Keys with the given prefix, in no particular order. */
  keys: (prefix: string) => Promise<string[]>;
}
//#endregion