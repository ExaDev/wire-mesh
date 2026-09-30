// The identity and grants surface as one collapsible section of the console: the device identity with its backup flow, and the grants panel. Kept apart from App so the grant state lives with the panel that shows it.

import { Accordion } from "@mantine/core";
import type { RevocationEntry } from "wire-mesh-core/generated/protocol";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { IdentityBackupService } from "../adapters/identity-backup.js";
import type { GrantStore } from "../grant-store.js";
import { useGrants } from "../hooks/use-grants.js";
import type { RevocationStore } from "../revocation-store.js";
import { GrantsPanel } from "./GrantsPanel.js";
import { IdentityPanel } from "./IdentityPanel.js";

export interface IdentitySectionProps {
  identity: IdentityPort;
  clock: Clock;
  grants: GrantStore;
  revocations: RevocationStore;
  identityBackup: IdentityBackupService;
  /** Tells every connected node about a revocation this device just made. */
  announceRevocation: (entry: RevocationEntry) => Promise<void>;
}

export function IdentitySection({
  identity,
  clock,
  grants,
  revocations,
  identityBackup,
  announceRevocation,
}: Readonly<IdentitySectionProps>): React.JSX.Element {
  const api = useGrants({
    identity,
    clock,
    grants,
    revocations,
    announce: announceRevocation,
  });
  return (
    <Accordion multiple variant="contained" data-testid="identity-section">
      <Accordion.Item value="identity">
        <Accordion.Control>Identity</Accordion.Control>
        <Accordion.Panel>
          <IdentityPanel identity={identity} backup={identityBackup} />
        </Accordion.Panel>
      </Accordion.Item>
      <Accordion.Item value="grants">
        <Accordion.Control>Grants</Accordion.Control>
        <Accordion.Panel>
          <GrantsPanel grants={api} clock={clock} />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
