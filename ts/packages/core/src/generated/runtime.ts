// The generated protocol.ts module (produced by generate.ts, committed alongside this file) imports its cbor-decoding helper as a same-directory sibling, "./runtime.js" -- matching where cddl.js's own CLI writes output. This re-export gives it that sibling here, without duplicating cddl.js's own runtime.ts content.
export { cborDecodesAs } from "cddl.js/runtime";
