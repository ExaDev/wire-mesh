// One list of grants, either the ones this device holds or the ones it issued. Each row shows the capability, what it is over, the other party, when it expires and whether it still holds, with inspection and, for issued grants, revocation.

import { Fragment, useState } from "react";
import { Badge, Button, Group, Text } from "@mantine/core";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { formatAgo, formatUntil } from "../format-duration.js";
import { describeGrantStatus } from "../grants.js";
import type { GrantRow } from "../hooks/use-grants.js";
import { GrantDetails } from "./GrantDetails.js";
import { PeerLabel } from "./PeerLabel.js";
import { StackedTable } from "./StackedTable.js";

export interface GrantTableProps {
  title: string;
  rows: readonly GrantRow[];
  /** Whose device-id fills the "from"/"to" column: the issuer of a held grant, the bearer of an issued one. */
  other: "issuer" | "bearer";
  now: number;
  /** Present only for issued grants, which are the only ones this device can revoke. */
  onRevoke?: (row: Readonly<GrantRow>) => void;
}

function expiry(expires: number, now: number): string {
  return expires > now ? formatUntil(expires - now) : formatAgo(now - expires);
}

export function GrantTable({
  title,
  rows,
  other,
  now,
  onRevoke,
}: Readonly<GrantTableProps>): React.JSX.Element {
  const [inspected, setInspected] = useState<string | undefined>(undefined);
  // The grant whose revocation is awaiting confirmation: revoking cannot be undone.
  const [revoking, setRevoking] = useState<string | undefined>(undefined);
  return (
    <div data-testid={`grants-${title.toLowerCase()}`}>
      <Text fw={600} size="sm" mt="sm">
        {title}
      </Text>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          None.
        </Text>
      ) : (
        <StackedTable
          columns={[
            { label: "capability" },
            { label: "over" },
            { label: other === "issuer" ? "from" : "to" },
            { label: "expires" },
            { label: "status" },
            { label: "actions", headerless: true },
          ]}
          rows={rows.map((row) => ({
            key: `${row.direction}/${row.tokenId}`,
            cells: [
              row.claims.capability,
              `${row.claims.scope.kind}${row.claims.scope.path === undefined ? "" : ` ${row.claims.scope.path}`}`,
              <PeerLabel
                key="other"
                deviceHex={deviceIdToHex(row.claims[other])}
              />,
              expiry(row.claims.expires, now),
              <Badge
                key="status"
                color={row.status.kind === "valid" ? "green" : "red"}
                variant="light"
              >
                {describeGrantStatus(row.status)}
              </Badge>,
              <Fragment key="actions">
                <Group gap="xs">
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => {
                      setInspected(
                        inspected === row.tokenId ? undefined : row.tokenId,
                      );
                    }}
                  >
                    {inspected === row.tokenId ? "Hide" : "Inspect"}
                  </Button>
                  {onRevoke !== undefined && row.status.kind === "valid" && (
                    <Button
                      size="xs"
                      color="red"
                      variant={revoking === row.tokenId ? "filled" : "light"}
                      onClick={() => {
                        if (revoking === row.tokenId) {
                          setRevoking(undefined);
                          onRevoke(row);
                        } else {
                          setRevoking(row.tokenId);
                        }
                      }}
                    >
                      {revoking === row.tokenId
                        ? "Confirm: revoke for good"
                        : "Revoke"}
                    </Button>
                  )}
                </Group>
                {inspected === row.tokenId && <GrantDetails row={row} />}
              </Fragment>,
            ],
          }))}
        />
      )}
    </div>
  );
}
