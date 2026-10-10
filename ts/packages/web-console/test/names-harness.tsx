// Wraps a component in the naming context over an in-memory name store, the way App does for the real tree.

import { useEffect } from "react";
import { MantineProvider } from "@mantine/core";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { deviceIdFromHex } from "wire-mesh-core/domain/device-id";
import { PeerNamesProvider } from "../src/components/PeerNamesProvider.js";
import { usePeerNames } from "../src/hooks/use-peer-names.js";
import { createNameStore } from "../src/name-store.js";
import { selfNameExtension } from "../src/peer-names.js";
import { syntheticAdvertProof } from "./synthetic-advert.js";
import type { NameStore } from "../src/name-store.js";

export function memoryNameStore(): NameStore {
  return createNameStore(createMemoryStorage());
}

export function WithNames({
  store = memoryNameStore(),
  children,
}: Readonly<{
  store?: NameStore;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <MantineProvider>
      <PeerNamesProvider store={store}>{children}</PeerNamesProvider>
    </MantineProvider>
  );
}

/** Feeds the naming context a directory in which `deviceHex` asserts `selfName` about itself, the way a connection panel does with a connected node's directory. */
export function AssertsSelfName({
  deviceHex,
  selfName,
}: Readonly<{ deviceHex: string; selfName: string }>): null {
  const { observeDirectory } = usePeerNames();
  useEffect(() => {
    const device = deviceIdFromHex(deviceHex);
    observeDirectory([
      {
        device,
        advert: {
          device,
          addresses: [],
          "snapshot-seconds": 0,
          ...syntheticAdvertProof(),
          ...selfNameExtension(selfName),
        },
      },
    ]);
  }, [deviceHex, selfName, observeDirectory]);

  return null;
}
