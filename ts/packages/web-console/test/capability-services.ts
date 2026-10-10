// The capability state a test gives the code under test: a grant store and a revocation store over in-memory storage, and the services bundle messaging takes.

import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { CapabilityServices } from "../src/capability-services.js";
import { createGrantStore } from "../src/grant-store.js";
import type { GrantStore } from "../src/grant-store.js";
import { createRevocationStore } from "../src/revocation-store.js";
import type { RevocationStore } from "../src/revocation-store.js";

export interface TestCapabilities {
  grants: GrantStore;
  revocations: RevocationStore;
  services: CapabilityServices;
}

export async function testCapabilities(
  identity: IdentityPort,
  clock: Readonly<Clock>,
): Promise<TestCapabilities> {
  const grants = createGrantStore(createMemoryStorage());
  const revocations = await createRevocationStore({
    storage: createMemoryStorage(),
    identity,
    clock,
  });

  return {
    grants,
    revocations,
    services: { revocation: revocations.view, grants },
  };
}
