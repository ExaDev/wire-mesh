// The grants this device holds and has issued, with minting, importing and revoking.

import { Stack, Text } from "@mantine/core";
import { useNow } from "../hooks/use-now.js";
import type { GrantsApi } from "../hooks/use-grants.js";
import type { Clock } from "wire-mesh-core/ports/clock";
import { GrantTable } from "./GrantTable.js";
import { ImportGrantForm } from "./ImportGrantForm.js";
import { MintGrantForm } from "./MintGrantForm.js";

/** How often the expiry times shown in the tables refresh. */
const CLOCK_TICK_MS = 1000;

export interface GrantsPanelProps {
  grants: Readonly<GrantsApi>;
  clock: Readonly<Clock>;
}

export function GrantsPanel({
  grants,
  clock,
}: Readonly<GrantsPanelProps>): React.JSX.Element {
  const now = useNow(clock, true, CLOCK_TICK_MS);
  const held = grants.rows.filter((row) => row.direction === "held");
  const issued = grants.rows.filter((row) => row.direction === "issued");
  return (
    <Stack gap="xs" data-testid="grants-panel">
      <Text size="sm" c="dimmed">
        A grant is a signed statement that one device may do something over
        something until a time. Revoking one you issued is recorded here, where
        this console stops honouring it at once, and sent to the nodes you are
        connected to. A node only passes it on if it relays revocations, which
        the hub does not.
      </Text>
      <GrantTable title="Held" rows={held} other="issuer" now={now} />
      <GrantTable
        title="Issued"
        rows={issued}
        other="bearer"
        now={now}
        onRevoke={(row) => {
          void grants.revoke(row);
        }}
      />
      <MintGrantForm
        delegable={held.filter((row) => row.status.kind === "valid")}
        onMint={grants.mint}
      />
      <ImportGrantForm onImport={grants.importCode} />
    </Stack>
  );
}
