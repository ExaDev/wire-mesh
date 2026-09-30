// The capability state the console's messaging shares: what token checks consult to refuse a revoked grant, and where the grants the console receives or issues are recorded. One of each for the whole console, so a revocation made in the grants panel is the same one a room verifies against.

import type { RevocationCheck } from "wire-mesh-core/domain/tokens";
import type { GrantStore } from "./grant-store.js";

export interface CapabilityServices {
  revocation: RevocationCheck;
  grants: GrantStore;
}
