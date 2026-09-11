Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const require_generated_protocol = require("../generated/protocol.cjs");
let cbor2 = require("cbor2");
//#region src/domain/tokens.ts
function bytesEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}
/** True when the path contains a "." or ".." segment. Purely lexical prefix comparison would let "/work/../org" pass under "/work" -- a path that normalises outside the parent -- so any relative segment fails the narrowing comparison wholesale: fail-closed rather than reimplementing path normalisation, consistent with how empty, case-different, and non-boundary-prefixed paths already behave. */
function hasRelativeSegment(path) {
	return path.split("/").some((segment) => segment === "." || segment === "..");
}
/** True when childPath is parentPath or a descendant of it, compared on "/"-segment boundaries: "/work/sub" narrows "/work", but "/workbook" does NOT narrow "/work" despite the string prefix, because "book" continues the same segment. Paths containing "." or ".." segments never narrow anything (see hasRelativeSegment). */
function pathNarrows(childPath, parentPath) {
	if (hasRelativeSegment(childPath) || hasRelativeSegment(parentPath)) return false;
	if (childPath === parentPath) return true;
	if (!childPath.startsWith(parentPath)) return false;
	if (parentPath.endsWith("/")) return true;
	return childPath.charAt(parentPath.length) === "/";
}
/**
* True when childScope narrows parentScope per tokens.cddl ("each hop can only narrow authority, never widen it"): the kind must be identical (a different kind is a different kind of authority, not a narrower one), and a parent with a path requires the child to carry an equal-or-descendant path -- an absent child path means the kind's whole-scope root, which is wider than any path-narrowed parent. A parent with no path (whole-scope root) lets any child path under the same kind through.
*/
function scopeNarrows(parent, child) {
	if (parent.kind !== child.kind) return false;
	if (parent.path === void 0) return true;
	if (child.path === void 0) return false;
	return pathNarrows(child.path, parent.path);
}
/** RFC 9052 §4.4 Sig_structure for a COSE_Sign1 with no external AAD: ["Signature1", protected, external_aad, payload]. */
function sig1ToBeSigned(protectedHeader, payload) {
	return (0, cbor2.encode)([
		"Signature1",
		protectedHeader,
		/* @__PURE__ */ new Uint8Array(0),
		payload
	], cbor2.cdeEncodeOptions);
}
/** Normalises cbor2's encode() (and any other Uint8Array<ArrayBufferLike>-typed construction) to a fresh, non-shared, whole-buffer Uint8Array<ArrayBuffer> -- what the generated schemas' concrete-typed fields require. */
function buf(bytes) {
	return Uint8Array.from(bytes);
}
function encodeBuf(value) {
	return buf((0, cbor2.encode)(value, cbor2.cdeEncodeOptions));
}
/** The COSE protected header every capability-token/revocation-entry envelope in this codebase actually signs over: label 1 (alg) and label 4 (kid, the issuer's own device-id) -- matching the frozen conformance vectors, not the empty header a token merely needs to verify against itself. */
function protectedHeaderFor(identity) {
	return encodeBuf({
		1: identity.identityKey.alg,
		4: identity.deviceId
	});
}
/** Decodes and validates a parent token's own claims from its raw CapabilityToken tuple -- the same decode `verifyTokenChain` performs on `claims.parent`, extracted here so mint can check narrowing against a parent's real claims without duplicating the CBOR/schema plumbing. Returns undefined for anything that doesn't parse; the caller turns that into its own refusal reason since "malformed" means something different at mint time than at verify time. */
function decodeTokenClaims(token) {
	const [, , payload] = token;
	if (payload === null) return void 0;
	let decoded;
	try {
		decoded = (0, cbor2.decode)(payload, cbor2.cdeDecodeOptions);
	} catch {
		return;
	}
	const result = require_generated_protocol.tokenClaimsSchema.safeParse(decoded);
	return result.success ? result.data : void 0;
}
/**
* Verifies one capability token per tokens.cddl's own documented rules: the token is a well-formed COSE_Sign1 whose signature actually verifies against its own embedded issuer-key, that issuer-key is self-certifying (sha256(issuer-key.public-key) equals the claimed issuer device-id -- no shared secret needed to check this), the token is currently valid (not expired, not before not-before, not revoked by its own issuer), and -- recursively -- any parent delegation narrows rather than widens across all three axes of authority: the parent's bearer must be this token's issuer (the delegation chain is unbroken), this token's expiry must not exceed its parent's, and this token's scope must narrow its parent's (same kind; equal-or-descendant path when the parent carries one) with an identical capability verb (the capability-verb grammar has no sub-verb relation, so a different verb is a different authority, not a narrower one). Undecodable payload bytes return "malformed" and undecodable parent bytes return "parent_invalid" -- hostile input produces a verdict, never a throw.
*/
async function verifyCapabilityToken(token, options) {
	const verdict = await verifyTokenChain(token, {
		identity: options.identity,
		clock: options.clock,
		revocation: options.revocation
	});
	if (!verdict.ok) return verdict;
	if (options.expectedBearer !== void 0 && !bytesEqual(verdict.claims.bearer, options.expectedBearer)) return {
		ok: false,
		reason: "bearer_mismatch"
	};
	return verdict;
}
async function verifyTokenChain(token, options) {
	const [protectedHeader, , payload, signature] = token;
	if (payload === null) return {
		ok: false,
		reason: "malformed"
	};
	let decodedClaims;
	try {
		decodedClaims = (0, cbor2.decode)(payload, cbor2.cdeDecodeOptions);
	} catch {
		return {
			ok: false,
			reason: "malformed"
		};
	}
	const claimsResult = require_generated_protocol.tokenClaimsSchema.safeParse(decodedClaims);
	if (!claimsResult.success) return {
		ok: false,
		reason: "malformed"
	};
	const claims = claimsResult.data;
	if (!await options.identity.verify(claims["issuer-key"], sig1ToBeSigned(protectedHeader, payload), signature)) return {
		ok: false,
		reason: "bad_signature"
	};
	if (!bytesEqual(await options.identity.deriveDeviceId(claims["issuer-key"]["public-key"]), claims.issuer)) return {
		ok: false,
		reason: "wrong_issuer"
	};
	const now = options.clock.now();
	if (claims.expires <= now) return {
		ok: false,
		reason: "expired"
	};
	if (claims["not-before"] !== void 0 && claims["not-before"] > now) return {
		ok: false,
		reason: "not_yet_valid"
	};
	if (await options.revocation.isRevoked(claims["token-id"], claims.issuer)) return {
		ok: false,
		reason: "revoked"
	};
	if (claims.parent !== void 0) {
		let decodedParent;
		try {
			decodedParent = (0, cbor2.decode)(claims.parent, cbor2.cdeDecodeOptions);
		} catch {
			return {
				ok: false,
				reason: "parent_invalid"
			};
		}
		const parentResult = require_generated_protocol.capabilityTokenSchema.safeParse(decodedParent);
		if (!parentResult.success) return {
			ok: false,
			reason: "parent_invalid"
		};
		const parentVerdict = await verifyTokenChain(parentResult.data, options);
		if (!parentVerdict.ok) return {
			ok: false,
			reason: "parent_invalid"
		};
		if (!bytesEqual(parentVerdict.claims.bearer, claims.issuer)) return {
			ok: false,
			reason: "delegation_exceeds_parent"
		};
		if (claims.expires > parentVerdict.claims.expires) return {
			ok: false,
			reason: "delegation_exceeds_parent"
		};
		if (!scopeNarrows(parentVerdict.claims.scope, claims.scope)) return {
			ok: false,
			reason: "delegation_exceeds_parent"
		};
		if (parentVerdict.claims.capability !== claims.capability) return {
			ok: false,
			reason: "delegation_exceeds_parent"
		};
	}
	return {
		ok: true,
		claims
	};
}
/**
* Verifies one gossiped revocation-entry (management.cddl): a well-formed COSE_Sign1 whose signature verifies against its own embedded issuer-key, where that issuer-key is self-certifying (sha256(issuer-key.public-key) equals the claimed issuer device-id). A verifier that ingests a revocation-announce frame runs each entry through this before recording it in its revocation view; entries failing here are dropped, not stored. The issuer-match against a specific token's own issuer (only a token's own issuer may revoke it) is deliberately NOT checked here -- it happens at lookup time in RevocationCheck, against whichever token is being verified.
*/
async function verifyRevocationEntry(entry, options) {
	const [protectedHeader, , payload, signature] = entry;
	if (payload === null) return {
		ok: false,
		reason: "malformed"
	};
	let decodedClaims;
	try {
		decodedClaims = (0, cbor2.decode)(payload, cbor2.cdeDecodeOptions);
	} catch {
		return {
			ok: false,
			reason: "malformed"
		};
	}
	const claimsResult = require_generated_protocol.revocationClaimsSchema.safeParse(decodedClaims);
	if (!claimsResult.success) return {
		ok: false,
		reason: "malformed"
	};
	const claims = claimsResult.data;
	if (!await options.identity.verify(claims["issuer-key"], sig1ToBeSigned(protectedHeader, payload), signature)) return {
		ok: false,
		reason: "bad_signature"
	};
	if (!bytesEqual(await options.identity.deriveDeviceId(claims["issuer-key"]["public-key"]), claims.issuer)) return {
		ok: false,
		reason: "wrong_issuer"
	};
	return {
		ok: true,
		claims
	};
}
/**
* Mints one capability token: builds token-claims from the given fields, signs it as a COSE_Sign1 under `identity`'s own key, with a protected header matching what the frozen conformance vectors actually encode (`{1: alg, 4: issuer device-id}`, not the empty header a token merely needs to verify against itself).
*
* When `parent` is given, every one of `tokens.cddl`'s own narrowing obligations is enforced here, at issuance, rather than left for the far end to discover minutes or hours later as a bare `delegation_exceeds_parent` from `verifyCapabilityToken` -- the same "fail loudly, fail early" reasoning that governs every other boundary in this codebase. An issuer minting an invalid delegation is a bug in the caller; this function refuses rather than producing a token indistinguishable from a valid one until someone else verifies it.
*/
async function mintCapabilityToken(options) {
	if (options.expires <= options.clock.now()) return {
		ok: false,
		reason: "already_expired"
	};
	let parentBytes;
	if (options.parent !== void 0) {
		const parentClaims = decodeTokenClaims(options.parent);
		if (parentClaims === void 0) return {
			ok: false,
			reason: "parent_malformed"
		};
		if (!bytesEqual(parentClaims.bearer, options.identity.deviceId)) return {
			ok: false,
			reason: "parent_bearer_mismatch"
		};
		if (options.expires > parentClaims.expires) return {
			ok: false,
			reason: "expires_exceeds_parent"
		};
		if (!scopeNarrows(parentClaims.scope, options.scope)) return {
			ok: false,
			reason: "scope_does_not_narrow"
		};
		if (parentClaims.capability !== options.capability) return {
			ok: false,
			reason: "capability_mismatch"
		};
		const parentRemaining = parentClaims["delegations-remaining"];
		if (parentRemaining !== void 0 && (options.delegationsRemaining === void 0 || options.delegationsRemaining >= parentRemaining)) return {
			ok: false,
			reason: "delegation_exceeds_parent"
		};
		parentBytes = encodeBuf(options.parent);
	}
	const payload = encodeBuf({
		"token-id": options.tokenId,
		issuer: options.identity.deviceId,
		"issuer-key": options.identity.identityKey,
		bearer: options.bearer,
		capability: options.capability,
		scope: options.scope,
		expires: options.expires,
		...options.notBefore !== void 0 ? { "not-before": options.notBefore } : {},
		...parentBytes !== void 0 ? { parent: parentBytes } : {},
		...options.delegationsRemaining !== void 0 ? { "delegations-remaining": options.delegationsRemaining } : {}
	});
	const protectedHeader = protectedHeaderFor(options.identity);
	return {
		ok: true,
		token: [
			protectedHeader,
			{},
			payload,
			await options.identity.sign(sig1ToBeSigned(protectedHeader, payload))
		]
	};
}
/** Mints one revocation-entry (management.cddl): a COSE_Sign1 over revocation-claims, signed the same way mintCapabilityToken signs a token. No narrowing chain to check -- a revocation entry has no parent and cannot fail to be issuable the way a delegated token can, so this returns the entry directly rather than a verdict. */
async function mintRevocationEntry(options) {
	const payload = encodeBuf({
		"token-id": options.tokenId,
		issuer: options.identity.deviceId,
		"issuer-key": options.identity.identityKey,
		"revoked-at": options.revokedAt
	});
	const protectedHeader = protectedHeaderFor(options.identity);
	return [
		protectedHeader,
		{},
		payload,
		await options.identity.sign(sig1ToBeSigned(protectedHeader, payload))
	];
}
//#endregion
exports.mintCapabilityToken = mintCapabilityToken;
exports.mintRevocationEntry = mintRevocationEntry;
exports.verifyCapabilityToken = verifyCapabilityToken;
exports.verifyRevocationEntry = verifyRevocationEntry;
