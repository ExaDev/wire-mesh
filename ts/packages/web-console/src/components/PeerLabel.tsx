// One peer as a person reads it: the label from the naming convention, the short id as a copy target for the full device-id, and an inline rename that sets this viewer's own petname.

import { useState } from "react";
import {
  ActionIcon,
  CopyButton,
  Group,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { usePeerNames } from "../hooks/use-peer-names.js";

/** Focuses the rename field as it appears, so the keyboard lands where the click that opened it was aimed. */
function focusOnMount(input: HTMLInputElement | null): void {
  input?.focus();
}

export interface PeerLabelProps {
  deviceHex: string;
}

export function PeerLabel({
  deviceHex,
}: Readonly<PeerLabelProps>): React.JSX.Element {
  const names = usePeerNames();
  const label = names.labelOf(deviceHex);
  const [draft, setDraft] = useState<string | undefined>(undefined);

  if (draft !== undefined) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void names.rename(deviceHex, draft).then(() => {
            setDraft(undefined);
          });
        }}
      >
        <Group gap="xs" wrap="nowrap">
          <TextInput
            size="xs"
            aria-label={`Petname for ${label.primary}`}
            value={draft}
            ref={focusOnMount}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
            }}
          />
          <ActionIcon type="submit" size="sm" aria-label="Save petname">
            ✓
          </ActionIcon>
          <ActionIcon
            size="sm"
            variant="subtle"
            aria-label="Cancel rename"
            onClick={() => {
              setDraft(undefined);
            }}
          >
            ×
          </ActionIcon>
        </Group>
      </form>
    );
  }

  return (
    <Group gap="xs" wrap="nowrap">
      <div>
        <Text
          size="sm"
          fw={label.source === "id" ? "normal" : "bold"}
          ff={label.source === "id" ? "monospace" : "text"}
        >
          {label.primary}
        </Text>
        {label.secondary !== undefined && (
          <Text
            size="xs"
            c="dimmed"
            ff={label.source === "self" ? "monospace" : "text"}
          >
            {label.secondary}
          </Text>
        )}
      </div>
      <CopyButton value={deviceHex}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied" : "Copy device id"}>
            <ActionIcon
              size="sm"
              variant="subtle"
              aria-label={`Copy device id of ${label.primary}`}
              onClick={copy}
            >
              ⧉
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
      <ActionIcon
        size="sm"
        variant="subtle"
        aria-label={`Rename ${label.primary}`}
        onClick={() => {
          setDraft(names.petnameOf(deviceHex) ?? "");
        }}
      >
        ✎
      </ActionIcon>
    </Group>
  );
}
