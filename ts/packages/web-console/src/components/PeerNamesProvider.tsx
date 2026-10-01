// Holds the petnames loaded from the console's name store and the self display names observed in directories, and serves them through PeerNamesContext.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@mantine/core";
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
  const [storageFailure, setStorageFailure] = useState<string | undefined>(
    undefined,
  );

  /** Runs one storage operation and shows its failure to the person, since names are read and written from event handlers with no caller positioned to handle a rejection. */
  const reportFailure = useCallback(
    async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
        setStorageFailure(undefined);
      } catch (error: unknown) {
        setStorageFailure(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [],
  );

  useEffect(() => {
    Promise.all([store.petnames(), store.selfName()]).then(
      ([loadedPetnames, loadedSelfName]) => {
        setPetnames(loadedPetnames);
        setOwnName(loadedSelfName);
      },
      (error: unknown) => {
        setStorageFailure(
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  }, [store]);

  const rename = useCallback(
    async (deviceHex: string, name: string): Promise<void> =>
      reportFailure(async () => {
        await store.setPetname(deviceHex, name);
        setPetnames(await store.petnames());
      }),
    [store, reportFailure],
  );

  const setSelfName = useCallback(
    async (name: string): Promise<void> =>
      reportFailure(async () => {
        await store.setSelfName(name);
        setOwnName(await store.selfName());
      }),
    [store, reportFailure],
  );

  const observeDirectory = useCallback(
    (directory: readonly DirectoryEntry[]): void => {
      setSelfNames((current) => {
        let next: Map<string, string> | undefined;
        for (const entry of directory) {
          const name = selfAssertedName(entry.advert);
          const hex = deviceIdToHex(entry.device);
          if (current.get(hex) === name) continue;
          next ??= new Map(current);
          // A later advert without a valid name retracts the earlier claim.
          if (name === undefined) {
            next.delete(hex);
          } else {
            next.set(hex, name);
          }
        }
        return next ?? current;
      });
    },
    [],
  );

  const heldPetnames = useMemo(() => new Set(petnames.values()), [petnames]);

  const value = useMemo<PeerNames>(
    () => ({
      labelOf: (deviceHex) =>
        labelPeer(
          deviceHex,
          petnames.get(deviceHex),
          selfNames.get(deviceHex),
          heldPetnames,
        ),
      petnameOf: (deviceHex) => petnames.get(deviceHex),
      rename,
      selfName,
      setSelfName,
      observeDirectory,
    }),
    [
      petnames,
      heldPetnames,
      selfNames,
      selfName,
      rename,
      setSelfName,
      observeDirectory,
    ],
  );

  return (
    <PeerNamesContext.Provider value={value}>
      {storageFailure !== undefined && (
        <Alert color="red" title="Saved names are unavailable" mb="md">
          {storageFailure}
        </Alert>
      )}
      {children}
    </PeerNamesContext.Provider>
  );
}
