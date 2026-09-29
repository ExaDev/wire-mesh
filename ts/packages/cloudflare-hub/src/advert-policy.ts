// What the public hub carries of a peer-advert's extension tail. Anyone can connect to this hub and it forwards every advert whole to every client (an advert is signed, so it cannot be trimmed on the way through), so anything an application puts in its tail is published to strangers. The hub therefore carries only the extension entries listed here, each held to an exact shape, and refuses an advert with anything else.
//
// The entries mirror what agent-comms publishes to a hub session: an agent's name and harness, its user principal's membership proof, its presence, the public rooms it hosts by path and name, and the package versions it runs. What it deliberately does not carry is the rest of what a bridge knows about itself (its working directory, process id, joined rooms, tags, private rooms and room descriptions), which is for peers it has chosen to trust and reaches them over a session of their own. The shapes are duplicated here rather than imported because agent-comms depends on wire-mesh and not the other way round; registering them properly is wire-mesh#242.

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

/** A list of public rooms, each with exactly a path and a name. A room description is not allowed: a project room's default one names the directory it was made for. */
const isPublicRoomList: ExtensionValidator = (value) => {
  const roomShape = exactStrings(["path", "name", "type"], []);
  return (
    Array.isArray(value) &&
    value.every(
      (room) => roomShape(room) && isRecord(room) && room.type === "public",
    )
  );
};

const AGENT_STATUSES: ReadonlySet<unknown> = new Set([
  "active",
  "idle",
  "busy",
  "offline",
]);

export const publicHubAdvertPolicy: AdvertExtensionPolicy = {
  allowed: {
    "agent/self": exactStrings(["name", "harness"], ["membership"]),
    "presence/status": (value) => AGENT_STATUSES.has(value),
    "agent-comms/version": exactStrings(["agentComms"], ["ccPeer"]),
    "room/hosted": isPublicRoomList,
  },
};
