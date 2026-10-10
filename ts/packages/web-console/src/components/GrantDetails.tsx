// Everything one grant says about itself, for inspection: who issued it and to whom, what it allows and over what, its limits, its current status, and the grant code that carries it to another device.

import { Code, CopyButton, Button, Stack, Text, Textarea } from "@mantine/core";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { encodeGrantCode, describeGrantStatus } from "../grants.js";
import type { GrantRow } from "../hooks/use-grants.js";
import { PeerName } from "./PeerName.js";

function Field({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <Text size="sm">
      <Text span fw={600}>
        {label}:
      </Text>{" "}
      {children}
    </Text>
  );
}

export function GrantDetails({
  row,
}: Readonly<{ row: GrantRow }>): React.JSX.Element {
  const { claims } = row;
  const code = encodeGrantCode(row.token);

  return (
    <Stack gap={4} data-testid="grant-details">
      <Field label="Token id">
        <Code>{row.tokenId}</Code>
      </Field>
      <Field label="Issuer">
        <PeerName deviceHex={deviceIdToHex(claims.issuer)} />
      </Field>
      <Field label="Bearer">
        <PeerName deviceHex={deviceIdToHex(claims.bearer)} />
      </Field>
      <Field label="Allows">
        {claims.capability} over {claims.scope.kind}
        {claims.scope.path === undefined ? "" : ` ${claims.scope.path}`}
      </Field>
      <Field label="Expires">{new Date(claims.expires).toISOString()}</Field>
      {claims["not-before"] !== undefined && (
        <Field label="Not before">
          {new Date(claims["not-before"]).toISOString()}
        </Field>
      )}
      {claims["delegations-remaining"] !== undefined && (
        <Field label="Further delegations">
          {claims["delegations-remaining"]}
        </Field>
      )}
      {claims.parent !== undefined && (
        <Field label="Delegated from">
          another grant (its parent rides inside this one)
        </Field>
      )}
      <Field label="Status">{describeGrantStatus(row.status)}</Field>
      <Textarea
        readOnly
        label="Grant code"
        description="Paste this into the other device's grant import to give it this grant."
        value={code}
        autosize
        minRows={2}
        maxRows={4}
      />
      <CopyButton value={code}>
        {({ copied, copy }) => (
          <Button size="xs" variant="light" onClick={copy} w="fit-content">
            {copied ? "Copied" : "Copy grant code"}
          </Button>
        )}
      </CopyButton>
    </Stack>
  );
}
