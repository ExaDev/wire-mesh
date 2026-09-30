// Holds the petnames loaded from the console's name store and the self display names observed in directories, and serves them through PeerNamesContext.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { NameStore } from "../name-store.js";
import { labelPeer, selfAssertedName } from "../peer-names.js";
import { PeerNamesContext } from "../hooks/use-peer-names.js";
import type { PeerNames } from "../hooks/use-peer-names.js";

export interface PeerNamesProviderProps {
  store: NameStore;
  children: React.ReactNode;
}

export function PeerNamesProvider({
  store,
  children,
}: Readonly<PeerNamesProviderProps>): React.JSX.Element {
  const [petnames, setPetnames] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [selfNames, setSelfNames] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [selfName, setOwnName] = useState<string | undefined>(undefined);

  useEffect(() => {
    void store.petnames().then(setPetnames);
    void store.selfName().then(setOwnName);
  }, [store]);

  const rename = useCallback(
    async (deviceHex: string, name: string): Promise<void> => {
      await store.setPetname(deviceHex, name);
      setPetnames(await store.petnames());
    },
    [store],
  );

  const setSelfName = useCallback(
    async (name: string): Promise<void> => {
      await store.setSelfName(name);
      setOwnName(await store.selfName());
    },
    [store],
  );

  const observeDirectory = useCallback(
    (directory: readonly DirectoryEntry[]): void => {
      setSelfNames((current) => {
        let next: Map<string, string> | undefined;
        for (const entry of directory) {
          const name = selfAssertedName(entry.advert);
          const hex = deviceIdToHex(entry.device);
          if (name !== undefined && current.get(hex) !== name) {
            next ??= new Map(current);
            next.set(hex, name);
          }
        }
        return next ?? current;
      });
    },
    [],
  );

  const value = useMemo<PeerNames>(
    () => ({
      labelOf: (deviceHex) =>
        labelPeer(deviceHex, petnames.get(deviceHex), selfNames.get(deviceHex)),
      petnameOf: (deviceHex) => petnames.get(deviceHex),
      rename,
      selfName,
      setSelfName,
      observeDirectory,
    }),
    [petnames, selfNames, selfName, rename, setSelfName, observeDirectory],
  );

  return (
    <PeerNamesContext.Provider value={value}>
      {children}
    </PeerNamesContext.Provider>
  );
}
