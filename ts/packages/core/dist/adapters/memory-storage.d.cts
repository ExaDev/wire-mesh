import { KeyValueStorage } from "../ports/storage.cjs";
//#region src/adapters/memory-storage.d.ts
/** An in-process KeyValueStorage backed by a Map -- for tests and single-process nodes; a real deployment substitutes a persistent adapter behind the same contract without touching anything that depends on the port. Not declared `async`: every operation is genuinely synchronous under the hood, so the contract's Promise return is satisfied directly via Promise.resolve() rather than an async function with no await in its body. */
export declare function createMemoryStorage(): KeyValueStorage;
//#endregion