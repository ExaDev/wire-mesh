// How a peer is named wherever it appears in the console. A device-id is 64 hex characters, which no person can hold in mind, so every surface shows the same three-tier label: a petname this viewer gave the device, else the name the device signed about itself, else a short id. Petnames live in this console's own storage and are never gossiped, so there is no global authority and no collision to resolve. The convention matches agent-comms, so the two surfaces read the same.

import type { PeerAdvert } from "wire-mesh-core/generated/protocol";

/** Leading hex characters of a device-id shown as its short id: enough to tell devices apart at a glance, and short enough to read aloud. */
export const SHORT_ID_LENGTH = 12;

/** A name longer than this is cut when shown. A self-asserted name arrives from a stranger through a hub that only checks it is a string, so the console bounds what it will lay out. */
export const MAX_NAME_LENGTH = 64;

/** The gossip extension a self display name travels in. It is the key agent-comms already publishes its agent name under, and the one the public hub's advert policy carries, so a console name reaches peers through that hub and agent-comms names appear here without a second convention. The advert signature covers every extension entry, so the name is signed by the device's own key. */
export const SELF_ADVERT_KEY = "agent/self";

/** The `harness` the same extension requires alongside `name`. */
export const CONSOLE_HARNESS = "wire-mesh-console";

/** Which tier of the naming convention produced a label. */
export type PeerLabelSource = "petname" | "self" | "id";

export interface PeerLabel {
  /** The text that names the peer: the petname, else the self display name, else the short id. */
  primary: string;
  /** What to show beside the primary text, or undefined when the primary is already the short id. A petname is shown with the peer's own claim so a renamed peer can still be recognised; a self name is shown with the short id so two peers claiming one name can be told apart. */
  secondary: string | undefined;
  source: PeerLabelSource;
  /** True when the primary text is a self-asserted name that equals a petname this viewer holds for some device, so the peer may be passing itself off as someone the viewer already named. Always false for a petname or a short id. */
  matchesPetname: boolean;
}

export function shortId(deviceHex: string): string {
  return deviceHex.slice(0, SHORT_ID_LENGTH);
}

/** Control characters and the bidirectional formatting characters (marks, embeddings, overrides, isolates). A self-asserted name is laid out beside neighbouring text, and these let a stranger reorder or hide that text. Other format characters such as the zero-width joiner stay, since emoji sequences need them. */
const UNSAFE_NAME_CHARACTERS =
  /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** A name fit to display: free of control and bidirectional formatting characters, non-empty, within MAX_NAME_LENGTH code points (never cutting a surrogate pair in half), and trimmed after that cut so a cut that lands after a space leaves no trailing space. */
export function cleanName(name: string): string | undefined {
  const trimmed = name.replace(UNSAFE_NAME_CHARACTERS, "").trim();
  if (trimmed === "") return undefined;

  return Array.from(trimmed).slice(0, MAX_NAME_LENGTH).join("").trimEnd();
}

/** The display name a peer signed about itself, read from its verified advert, or undefined when it published none or a malformed one. */
export function selfAssertedName(
  advert: Readonly<PeerAdvert>,
): string | undefined {
  const claim: unknown = advert[SELF_ADVERT_KEY];
  if (typeof claim !== "object" || claim === null) return undefined;
  if (!("name" in claim) || typeof claim.name !== "string") return undefined;

  return cleanName(claim.name);
}

/** The extension bag that publishes `name` as this device's own display name. */
export function selfNameExtension(name: string): Record<string, unknown> {
  return { [SELF_ADVERT_KEY]: { name, harness: CONSOLE_HARNESS } };
}

/** Labels a peer. `heldPetnames` is every petname this viewer holds, for any device, so a self-asserted name that copies one can be flagged. */
export function labelPeer(
  deviceHex: string,
  petname: string | undefined,
  selfName: string | undefined,
  heldPetnames: ReadonlySet<string>,
): PeerLabel {
  if (petname !== undefined) {
    return {
      primary: petname,
      secondary:
        selfName !== undefined && selfName !== petname ? selfName : undefined,
      source: "petname",
      matchesPetname: false,
    };
  }
  if (selfName !== undefined) {
    return {
      primary: selfName,
      secondary: shortId(deviceHex),
      source: "self",
      matchesPetname: heldPetnames.has(selfName),
    };
  }

  return {
    primary: shortId(deviceHex),
    secondary: undefined,
    source: "id",
    matchesPetname: false,
  };
}

/** A label as one line of plain text. A self-asserted name carries the short id so that two peers claiming the same name still read differently; a petname or a short id stands alone. */
export function labelText(label: Readonly<PeerLabel>): string {
  if (label.source === "self" && label.secondary !== undefined) {
    return `${label.primary} (${label.secondary})`;
  }

  return label.primary;
}
