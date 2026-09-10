import { Clock } from "../ports/clock.mjs";
//#region src/adapters/system-clock.d.ts
/** Wraps the system wall clock -- the only place Date.now() appears in this package. */
export declare function createSystemClock(): Clock;
//#endregion