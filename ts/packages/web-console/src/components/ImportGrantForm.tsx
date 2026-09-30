// Adds a grant another device gave this one, from the grant code it copied. Core's verifier decides whether this device can hold it: it must name this device as bearer and still be valid.

import { useState } from "react";
import { Alert, Button, Stack, Text, Textarea } from "@mantine/core";
import type { GrantActionResult } from "../hooks/use-grants.js";

export interface ImportGrantFormProps {
  onImport: (code: string) => Promise<GrantActionResult>;
}

export function ImportGrantForm({
  onImport,
}: Readonly<ImportGrantFormProps>): React.JSX.Element {
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<GrantActionResult | undefined>(
    undefined,
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onImport(code).then((result) => {
          setOutcome(result);
          if (result.ok) {
            setCode("");
          }
        });
      }}
    >
      <Stack gap="xs">
        <Text fw={600} size="sm" mt="md">
          Add a grant you were given
        </Text>
        <Textarea
          label="Grant code"
          value={code}
          onChange={(event) => {
            setCode(event.currentTarget.value);
          }}
          autosize
          minRows={2}
          maxRows={4}
          required
        />
        <Button type="submit" size="xs" w="fit-content">
          Add grant
        </Button>
        {outcome?.ok === false && (
          <Alert color="red" title="Not added">
            {outcome.error}
          </Alert>
        )}
        {outcome?.ok === true && (
          <Alert color="green" title="Grant added">
            It is listed under Held.
          </Alert>
        )}
      </Stack>
    </form>
  );
}
