// Warns that some stored revocations could not be loaded, which means the grants they revoked may read as valid, and offers the recovery: discarding an entry that cannot be repaired. Nothing is shown when every stored revocation loaded.

import { useSyncExternalStore } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import type { RevocationStore } from "../revocation-store.js";

export interface UnreadableRevocationsProps {
  revocations: Pick<
    RevocationStore,
    "subscribe" | "unreadable" | "discardUnreadable"
  >;
  /** Reports a discard that failed, since the entry is then still stored and still unreadable. */
  onFailure: (message: string) => void;
}

export function UnreadableRevocations({
  revocations,
  onFailure,
}: Readonly<UnreadableRevocationsProps>): React.JSX.Element | null {
  const unreadable = useSyncExternalStore(
    revocations.subscribe,
    revocations.unreadable,
  );
  if (unreadable.length === 0) {
    return null;
  }
  return (
    <Alert
      color="red"
      title="Some stored revocations could not be loaded"
      data-testid="unreadable-revocations"
    >
      <Stack gap="xs">
        <Text size="sm">
          A grant that one of these revoked may read as valid until it is dealt
          with. Discarding an entry deletes it from this console&apos;s storage.
        </Text>
        {unreadable.map((entry) => (
          <Group key={entry.key} justify="space-between">
            <Text size="sm">
              {entry.key}: {entry.reason}
            </Text>
            <Button
              size="xs"
              color="red"
              variant="light"
              onClick={() => {
                revocations
                  .discardUnreadable(entry.key)
                  .catch((error: unknown) => {
                    onFailure(
                      error instanceof Error ? error.message : String(error),
                    );
                  });
              }}
            >
              Discard
            </Button>
          </Group>
        ))}
      </Stack>
    </Alert>
  );
}
