Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region src/adapters/system-clock.ts
/** Wraps the system wall clock -- the only place Date.now() appears in this package. */
function createSystemClock() {
	return { now: () => Date.now() };
}
//#endregion
exports.createSystemClock = createSystemClock;
