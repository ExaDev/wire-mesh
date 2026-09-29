// What the public hub carries of a peer-advert's extension tail. Anyone can connect to this hub and it forwards every advert whole to every client (an advert is signed, so it cannot be trimmed on the way through), so anything an application puts in its tail is published to strangers. The hub therefore carries only the extension entries listed here, each held to an exact shape, and refuses an advert with anything else.
//
// The entries are the ones agent-comms puts in an advert bound for a public hub, each under a key of its own so this policy can admit them without admitting the keys a private link carries: an agent's card (name, harness and its user principal's membership proof), its presence, the public rooms it hosts by path and name, and the package versions it runs. `agent/self` and `room/hosted`, which carry a working directory, process id, tags and every hosted room with its description, are not listed, so an advert holding either is refused whole. The shapes are duplicated here rather than imported because agent-comms depends on wire-mesh and not the other way round; registering them properly is wire-mesh#242.

import type {
  AdvertExtensionPolicy,
  ExtensionValidator,
} from "wire-mesh-core/domain/advert-extension-policy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object holding exactly the required string fields and, optionally, the optional ones, and nothing else. */
function exactStrings(
  required: readonly string[],
  optional: readonly string[],
): ExtensionValidator {
  return (value) => {
    if (!isRecord(value)) return false;
    const known = new Set([...required, ...optional]);
    if (Object.keys(value).some((key) => !known.has(key))) return false;
    if (required.some((key) => typeof value[key] !== "string")) return false;
    return optional.every(
      (key) => !(key in value) || typeof value[key] === "string",
    );
  };
}

/** A list of public rooms, each with exactly a path and a name. There is no description and no type: a description would name the directory a project room was made for, and only public rooms are listed at all. */
const isPublicRoomList: ExtensionValidator = (value) => {
  const roomShape = exactStrings(["path", "name"], []);
  return Array.isArray(value) && value.every((room) => roomShape(room));
};

const AGENT_STATUSES: ReadonlySet<unknown> = new Set([
  "active",
  "idle",
  "busy",
  "offline",
]);

export const publicHubAdvertPolicy: AdvertExtensionPolicy = {
  allowed: {
    "agent/card": exactStrings(["name", "harness"], ["membership"]),
    "presence/status": (value) => AGENT_STATUSES.has(value),
    "agent-comms/version": exactStrings(["agentComms"], ["ccPeer"]),
    "room/public": isPublicRoomList,
  },
};
