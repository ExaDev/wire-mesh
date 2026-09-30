// The naming context every peer-bearing component reads, so the display convention (petname, then self display name, then short id) is implemented once in peer-names.ts and reached from ConversationList, the connection directory and the discovered-peers table alike.

import { createContext, useContext } from "react";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import type { PeerLabel } from "../peer-names.js";

export interface PeerNames {
  labelOf: (deviceHex: string) => PeerLabel;
  petnameOf: (deviceHex: string) => string | undefined;
  /** Gives a device a petname of this viewer's own, or removes it when blank. */
  rename: (deviceHex: string, name: string) => Promise<void>;
  /** This console's own display name, published in its gossip adverts. */
  selfName: string | undefined;
  setSelfName: (name: string) => Promise<void>;
  /** Records the display names the verified adverts of a directory assert. */
  observeDirectory: (directory: readonly DirectoryEntry[]) => void;
}

export const PeerNamesContext = createContext<PeerNames | undefined>(undefined);

export function usePeerNames(): PeerNames {
  const names = useContext(PeerNamesContext);
  if (names === undefined) {
    throw new Error("usePeerNames must be used inside PeerNamesProvider");
  }
  return names;
}
