// The form for minting a grant: who it is for, what it allows and over what, how long it lasts, and optionally a held grant to delegate from or a held manage:grant that authorises the mint, in which case core refuses anything that would widen it or that the authorising grant bars. A manage:grant or manage:request also names the one verb it covers, and a manage:grant can bar its holder from granting chosen verbs to itself.

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
import { MANAGE_REQUEST_CAPABILITY } from "wire-mesh-core/domain/capability-request";
import { MANAGE_GRANT_CAPABILITY } from "wire-mesh-core/domain/tokens";
import { shortId } from "../peer-names.js";
import { KNOWN_CAPABILITIES } from "../mint-grant.js";
import type { MintGrantInput } from "../mint-grant.js";
import type { GrantActionResult, GrantRow } from "../hooks/use-grants.js";

const DEFAULT_LIFETIME_HOURS = 24;
const NO_PARENT = "root";
const NO_AUTHORISER = "none";

/** Splits a comma-separated list of verbs, dropping blanks. */
function verbList(text: string): string[] {
  return text
    .split(",")
    .map((verb) => verb.trim())
    .filter((verb) => verb !== "");
}

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
  const [authoriserId, setAuthoriserId] = useState<string>(NO_AUTHORISER);
  const [targetVerb, setTargetVerb] = useState("");
  const [barredVerbs, setBarredVerbs] = useState("");
  const [outcome, setOutcome] = useState<
    GrantActionResult<{ code: string }> | undefined
  >(undefined);

  const parent = delegable.find((row) => row.tokenId === parentId);
  const authoriser = delegable.find((row) => row.tokenId === authoriserId);
  const authorisers = delegable.filter(
    (row) => row.claims.capability === MANAGE_GRANT_CAPABILITY,
  );
  const namesVerb =
    capability === MANAGE_GRANT_CAPABILITY ||
    capability === MANAGE_REQUEST_CAPABILITY;

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
    // Same reasoning for an authorising grant that has lapsed since it was picked: minting without it would drop the bars it carried.
    if (authoriserId !== NO_AUTHORISER && authoriser === undefined) {
      setOutcome({
        ok: false,
        error:
          "the grant you chose to authorise this is no longer valid; choose another, or choose None to mint without one",
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
      authorisedBy: authoriser?.token,
      targetVerb: namesVerb ? targetVerb : "",
      selfGrantBars:
        capability === MANAGE_GRANT_CAPABILITY ? verbList(barredVerbs) : [],
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
        {namesVerb && (
          <TextInput
            label="Covered verb"
            description={
              capability === MANAGE_GRANT_CAPABILITY
                ? "The one verb the holder may grant, as subsystem:action. Empty means any verb within the scope."
                : "The one verb the holder may request, as subsystem:action. Empty means any verb within the scope."
            }
            value={targetVerb}
            onChange={(event) => {
              setTargetVerb(event.currentTarget.value);
            }}
          />
        )}
        {capability === MANAGE_GRANT_CAPABILITY && (
          <TextInput
            label="Barred from granting to itself"
            description="Comma-separated verbs the holder may not grant to its own device, for example manage:grant to stop it passing on the right to grant."
            value={barredVerbs}
            onChange={(event) => {
              setBarredVerbs(event.currentTarget.value);
            }}
          />
        )}
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
        <Select
          label="Authorised by"
          description="A manage:grant you hold that permits this mint; it may bar what you can grant. None means this grant is minted on your own authority."
          allowDeselect={false}
          data={[
            { value: NO_AUTHORISER, label: "None" },
            ...authorisers.map((row) => ({
              value: row.tokenId,
              label: `manage:grant from ${shortId(deviceIdToHex(row.claims.issuer))}`,
            })),
          ]}
          value={authoriserId}
          onChange={(value) => {
            setAuthoriserId(value ?? NO_AUTHORISER);
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
