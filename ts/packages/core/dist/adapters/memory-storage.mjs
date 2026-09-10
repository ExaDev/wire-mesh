//#region src/adapters/memory-storage.ts
/** An in-process KeyValueStorage backed by a Map -- for tests and single-process nodes; a real deployment substitutes a persistent adapter behind the same contract without touching anything that depends on the port. Not declared `async`: every operation is genuinely synchronous under the hood, so the contract's Promise return is satisfied directly via Promise.resolve() rather than an async function with no await in its body. */
function createMemoryStorage() {
	const store = /* @__PURE__ */ new Map();
	return {
		get: async (key) => Promise.resolve(store.get(key)),
		set: async (key, value) => Promise.resolve(store.set(key, value)).then(() => void 0),
		delete: async (key) => Promise.resolve(store.delete(key)).then(() => void 0),
		keys: async (prefix) => Promise.resolve([...store.keys()].filter((key) => key.startsWith(prefix)))
	};
}
//#endregion
export { createMemoryStorage };
