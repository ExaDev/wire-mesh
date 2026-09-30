// The field for this console's own display name: what it publishes, signed by its device key, to every node it connects to. Empty means it publishes none and peers see only its short id.

import { useState } from "react";
import { Button, Group, TextInput } from "@mantine/core";
import { usePeerNames } from "../hooks/use-peer-names.js";
import { MAX_NAME_LENGTH } from "../peer-names.js";

export function SelfNameField(): React.JSX.Element {
  const { selfName, setSelfName } = usePeerNames();
  // The text being typed, or undefined while the field just shows the saved name.
  const [edit, setEdit] = useState<string | undefined>(undefined);
  const draft = edit ?? selfName ?? "";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void setSelfName(draft).then(() => {
          setEdit(undefined);
        });
      }}
    >
      <Group align="flex-end" wrap="wrap">
        <TextInput
          label="Your display name"
          description="Shown to the peers you connect to, signed by this device's key. Leave empty to show only your short id."
          value={draft}
          maxLength={MAX_NAME_LENGTH}
          onChange={(event) => {
            setEdit(event.currentTarget.value);
          }}
          style={{ flex: 1, minWidth: "16rem" }}
        />
        <Button
          type="submit"
          variant="light"
          disabled={draft.trim() === (selfName ?? "")}
        >
          Save name
        </Button>
      </Group>
    </form>
  );
}
