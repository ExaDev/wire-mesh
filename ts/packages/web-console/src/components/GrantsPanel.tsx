// The grants this device holds and has issued, with minting, importing and revoking.

import { useState } from "react";
import { Alert, Stack, Text } from "@mantine/core";
import { useNow } from "../hooks/use-now.js";
import type {
  AnnounceResult,
  GrantActionResult,
  GrantsApi,
} from "../hooks/use-grants.js";
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

/** What to tell the person after a revocation: it is always recorded here, and how far it travelled depends on the connections open at the time. */
function describeRevocation(
  outcome: Readonly<GrantActionResult<{ announced: AnnounceResult }>>,
): { color: string; title: string; text: string } {
  if (!outcome.ok) {
    return { color: "red", title: "Not revoked", text: outcome.error };
  }
  const { attempted, reached } = outcome.announced;
  if (attempted === 0) {
    return {
      color: "yellow",
      title: "Revoked here only",
      text: "No connection was open, so no node was told. This console no longer honours the grant.",
    };
  }
  if (reached < attempted) {
    return {
      color: "yellow",
      title: "Revoked, but not every node was told",
      text: `Sent to ${String(reached)} of ${String(attempted)} connected nodes. This console no longer honours the grant.`,
    };
  }
  return {
    color: "green",
    title: "Revoked",
    text: `Sent to ${String(reached)} connected ${reached === 1 ? "node" : "nodes"}. This console no longer honours the grant.`,
  };
}

export function GrantsPanel({
  grants,
  clock,
}: Readonly<GrantsPanelProps>): React.JSX.Element {
  const now = useNow(clock, true, CLOCK_TICK_MS);
  const [revocation, setRevocation] = useState<
    GrantActionResult<{ announced: AnnounceResult }> | undefined
  >(undefined);
  const report =
    revocation === undefined ? undefined : describeRevocation(revocation);
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
      {grants.loadError !== undefined && (
        <Alert color="red" title="Grants could not be read">
          {grants.loadError}
        </Alert>
      )}
      <GrantTable title="Held" rows={held} other="issuer" now={now} />
      <GrantTable
        title="Issued"
        rows={issued}
        other="bearer"
        now={now}
        onRevoke={(row) => {
          grants.revoke(row).then(setRevocation, (error: unknown) => {
            setRevocation({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }}
      />
      {report !== undefined && (
        <Alert
          color={report.color}
          title={report.title}
          data-testid="revocation-report"
        >
          {report.text}
        </Alert>
      )}
      <MintGrantForm
        delegable={held.filter((row) => row.status.kind === "valid")}
        onMint={grants.mint}
      />
      <ImportGrantForm onImport={grants.importCode} />
    </Stack>
  );
}
