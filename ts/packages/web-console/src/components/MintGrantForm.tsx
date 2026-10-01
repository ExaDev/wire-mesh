// The form for minting a grant: who it is for, what it allows and over what, how long it lasts, and optionally a held grant to delegate from, in which case core refuses anything that would widen it.

import { useState } from "react";
import {
  Alert,
  Autocomplete,
  Button,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { shortId } from "../peer-names.js";
import { KNOWN_CAPABILITIES } from "../mint-grant.js";
import type { MintGrantInput } from "../mint-grant.js";
import type { GrantActionResult, GrantRow } from "../hooks/use-grants.js";

const DEFAULT_LIFETIME_HOURS = 24;
const NO_PARENT = "root";

export interface MintGrantFormProps {
  /** Grants this device holds and so can delegate from. */
  delegable: readonly GrantRow[];
  onMint: (
    input: Readonly<MintGrantInput>,
  ) => Promise<GrantActionResult<{ code: string }>>;
}

export function MintGrantForm({
  delegable,
  onMint,
}: Readonly<MintGrantFormProps>): React.JSX.Element {
  const [bearerHex, setBearerHex] = useState("");
  const [capability, setCapability] = useState("");
  const [scopeKind, setScopeKind] = useState("");
  const [scopePath, setScopePath] = useState("");
  const [lifetimeHours, setLifetimeHours] = useState<number>(
    DEFAULT_LIFETIME_HOURS,
  );
  const [delegations, setDelegations] = useState<number | "">("");
  const [parentId, setParentId] = useState<string>(NO_PARENT);
  const [outcome, setOutcome] = useState<
    GrantActionResult<{ code: string }> | undefined
  >(undefined);

  const parent = delegable.find((row) => row.tokenId === parentId);

  function submit(): void {
    // A chosen parent that has expired or been revoked since it was picked no longer appears in `delegable`. Minting anyway would issue a root grant, which is wider than the delegation asked for.
    if (parentId !== NO_PARENT && parent === undefined) {
      setOutcome({
        ok: false,
        error:
          "the grant you chose to delegate from is no longer valid; choose another, or choose Root grant to mint without one",
      });
      return;
    }
    onMint({
      bearerHex,
      capability,
      scopeKind,
      scopePath,
      lifetimeHours,
      delegationsRemaining: delegations === "" ? undefined : delegations,
      parent: parent?.token,
    }).then(setOutcome, (error: unknown) => {
      setOutcome({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Stack gap="xs">
        <Text fw={600} size="sm" mt="md">
          Mint a grant
        </Text>
        <TextInput
          label="Bearer device-id"
          description="The device the grant is for: 64 hex characters, copied from a peer's directory row."
          value={bearerHex}
          onChange={(event) => {
            setBearerHex(event.currentTarget.value);
          }}
          required
        />
        <Autocomplete
          label="Capability"
          description="What it allows, as subsystem:action."
          data={KNOWN_CAPABILITIES.map((known) => known.verb)}
          value={capability}
          onChange={(value) => {
            setCapability(value);
            const known = KNOWN_CAPABILITIES.find(
              (entry) => entry.verb === value,
            );
            if (known !== undefined) {
              setScopeKind(known.scopeKind);
            }
          }}
          required
        />
        <TextInput
          label="Scope kind"
          value={scopeKind}
          onChange={(event) => {
            setScopeKind(event.currentTarget.value);
          }}
          required
        />
        <TextInput
          label="Scope path"
          description="Leave empty for a scope with no path."
          value={scopePath}
          onChange={(event) => {
            setScopePath(event.currentTarget.value);
          }}
        />
        <NumberInput
          label="Lasts (hours)"
          min={0}
          value={lifetimeHours}
          onChange={(value) => {
            setLifetimeHours(typeof value === "number" ? value : 0);
          }}
        />
        <NumberInput
          label="Further delegations"
          description="How many times the bearer may pass it on. Empty leaves it unset."
          min={0}
          allowDecimal={false}
          value={delegations}
          onChange={(value) => {
            setDelegations(typeof value === "number" ? value : "");
          }}
        />
        <Select
          label="Delegate from"
          description="A grant you hold, which the new grant may only narrow. Root means none."
          allowDeselect={false}
          data={[
            { value: NO_PARENT, label: "Root grant (none)" },
            ...delegable.map((row) => ({
              value: row.tokenId,
              label: `${row.claims.capability} from ${shortId(deviceIdToHex(row.claims.issuer))}`,
            })),
          ]}
          value={parentId}
          onChange={(value) => {
            setParentId(value ?? NO_PARENT);
          }}
        />
        <Button type="submit" size="xs" w="fit-content">
          Mint grant
        </Button>
        {outcome?.ok === false && (
          <Alert color="red" title="Not minted">
            {outcome.error}
          </Alert>
        )}
        {outcome?.ok === true && (
          <Alert color="green" title="Grant minted">
            It is listed under Issued, where Inspect shows its grant code.
          </Alert>
        )}
      </Stack>
    </form>
  );
}
