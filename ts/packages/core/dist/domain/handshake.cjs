Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region src/domain/handshake.ts
/** The highest protocol version this build of core understands. */
const SUPPORTED_PROTOCOL_VERSION = 1;
/**
* Domain names that must never be negotiated, per handshake.cddl: core/federation is retired (its string stays reserved, never reused) and "a peer must never advertise or negotiate it". Excluded here even if both peers advertise it -- two buggy advertisers must not end up speaking a dead domain.
*/
const RETIRED_DOMAINS = ["core/federation"];
/**
* Negotiates protocol version and capability domains between a local and remote handshake -- the mechanism wire-mesh's handshake exists to provide, and agent-comms issue #31's fix: a mixed fleet of old and new peers negotiates down to what they both actually support, rather than one side silently misinterpreting frames the other can't produce yet.
*/
function negotiate(local, remote) {
	const version = Math.min(local.version, remote.version);
	const sharedDomains = local.domains.filter((domain) => !RETIRED_DOMAINS.includes(domain) && remote.domains.includes(domain));
	return {
		ok: version >= 1 && sharedDomains.length > 0,
		version,
		sharedDomains
	};
}
//#endregion
exports.SUPPORTED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSION;
exports.negotiate = negotiate;
