// This node's own actual, currently-running wire-mesh-core version (issue #179), and the core/version manage-command it rides on (version.cddl) -- not a public export, just an internal helper mesh-session.ts pulls in, the same non-entry role relay-pairing.ts already plays for its own connection-scoped state.
import type { ManageCommandParams, ManageOk } from "../generated/protocol.js";

// External so this genuinely reads the currently-installed package's own version at runtime rather than whatever was baked in at build time -- see tsdown.config.ts's own comment on this import. package.json's committed "version" is always the placeholder "0.0.0" (semantic-release/npm rewrites it only in the tarball it publishes, after this package has already been built), so a build-time-inlined value would always report the wrong version in every real release.
import packageJson from "../../package.json" with { type: "json" };

/** This node's own actual, currently-running wire-mesh-core version -- read once from the installed package's own package.json, never from anything gossiped or cached, so buildSelfAdvert's own self-advert extension and version.get's manage-response both always answer with the truth for this exact running process. */
export const OWN_VERSION = packageJson.version;

/** The gossip extension key wire-mesh-core itself injects into every self-advert (mesh-session.ts's own buildSelfAdvert) to report OWN_VERSION -- reserved so a sendGossipUpdate caller can never also supply it, separately from peer-advert's own typed struct fields (RESERVED_PEER_ADVERT_KEYS in mesh-session.ts), since this is just an extension-tail key (transport.cddl), not a struct field. */
export const CORE_VERSION_GOSSIP_KEY = "wire-mesh/version";

const VERSION_GET_VERB = "version.get";

/** True when params is the core/version domain's own version-get command (version.cddl) -- a receiver answers this unconditionally, bypassing incomingManageRequests entirely, since it is deliberately ungated: exactly as sensitive as what CORE_VERSION_GOSSIP_KEY already broadcasts unconditionally via gossip. */
export function isVersionGetCommand(params: ManageCommandParams): boolean {
  return "verb" in params && params.verb === VERSION_GET_VERB;
}

/** The manage-ok outcome mesh-session.ts answers a version.get request with -- OWN_VERSION on manage-ok's own open `* tstr => any` tail, the same pattern exec-list's own exec-session-info result already uses. */
export function versionGetOutcome(): ManageOk {
  return { result: "ok", version: OWN_VERSION };
}
