// Wraps a component in the naming context over an in-memory name store, the way App does for the real tree.

import { MantineProvider } from "@mantine/core";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { PeerNamesProvider } from "../src/components/PeerNamesProvider.js";
import { createNameStore } from "../src/name-store.js";
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
