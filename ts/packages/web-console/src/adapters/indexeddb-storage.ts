// A browser KeyValueStorage implementation over IndexedDB -- the one storage the console has that survives a reload, unlike an in-process Map. One object store holds opaque Uint8Array values keyed by string, matching the port's contract exactly; nothing here interprets what's stored.

import type { KeyValueStorage } from "@exadev/wire-mesh-core/ports/storage";

export interface IndexedDbStorageOptions {
  dbName?: string;
}

const DEFAULT_DB_NAME = "wire-mesh-web-console";
const STORE_NAME = "kv";
// The highest Unicode code point: appending it to a prefix gives an upper bound that is greater than every string sharing that prefix but less than any string that continues past it, letting IDBKeyRange.bound express a prefix scan as a real range query.
const PREFIX_UPPER_BOUND_SUFFIX = "\u{10FFFF}";

interface StoredRecord {
  key: string;
  value: Uint8Array;
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("key" in value) || !("value" in value)) return false;
  return typeof value.key === "string" && value.value instanceof Uint8Array;
}

function isStringKey(key: IDBValidKey): key is string {
  return typeof key === "string";
}

async function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed"));
    };
  });
}

/** get() alone needs its own wrapper rather than requestToPromise: IDBObjectStore.get's lib.dom typing returns IDBRequest<any>, so the result must be validated through a type guard (isStoredRecord) rather than trusted or cast -- this store's single shape is exactly what set() below ever writes. */
async function getRecord(
  objectStore: IDBObjectStore,
  key: string,
): Promise<StoredRecord | undefined> {
  return new Promise((resolve, reject) => {
    const request = objectStore.get(key);
    request.onsuccess = () => {
      const result: unknown = request.result;
      if (result === undefined) {
        resolve(undefined);
        return;
      }
      if (!isStoredRecord(result)) {
        reject(new Error("stored record is malformed"));
        return;
      }
      resolve(result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed"));
    };
  });
}

async function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open(dbName, 1);
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    openRequest.onsuccess = () => {
      resolve(openRequest.result);
    };
    openRequest.onerror = () => {
      reject(
        openRequest.error ?? new Error("failed to open IndexedDB database"),
      );
    };
  });
}

export async function createIndexedDbStorage(
  options?: IndexedDbStorageOptions,
): Promise<KeyValueStorage> {
  const db = await openDatabase(options?.dbName ?? DEFAULT_DB_NAME);

  function store(mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  return {
    async get(key) {
      const record = await getRecord(store("readonly"), key);
      return record?.value;
    },
    async set(key, value) {
      await requestToPromise(
        store("readwrite").put({ key, value } satisfies StoredRecord),
      );
    },
    async delete(key) {
      await requestToPromise(store("readwrite").delete(key));
    },
    async keys(prefix) {
      // Safe as a real range bound (rather than a full cursor scan with manual prefix filtering) specifically because every key this codebase constructs is ASCII, internally generated, and never taken verbatim from untrusted input -- there's no key value that could smuggle a code point past the upper bound and defeat the range.
      const range = IDBKeyRange.bound(
        prefix,
        prefix + PREFIX_UPPER_BOUND_SUFFIX,
      );
      const allKeys = await requestToPromise(
        store("readonly").getAllKeys(range),
      );
      return allKeys.map((key) => {
        if (!isStringKey(key)) {
          throw new Error("stored key is not a string");
        }
        return key;
      });
    },
  };
}
