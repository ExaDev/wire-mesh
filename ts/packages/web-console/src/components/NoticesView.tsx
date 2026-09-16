// Renders one room's replicated notices: decrypted text where this side holds the epoch key, an explicit "encrypted (no key)" placeholder where it does not, and nothing at all for entries that failed verification (the wiring layer already refuses to surface unverified content -- this component only renders what readRoom returns, and makes the verified-but-unreadable case visible rather than hiding it, since "valid notice you can't read" and "invalid notice" are different facts).

import { Badge, Box, Stack, Text } from "@mantine/core";
import type { NoticeBoardEntry } from "wire-mesh-core/domain/notice-board";

function textOf(entry: Readonly<NoticeBoardEntry>): string | undefined {
  if (entry.plaintext === undefined) return undefined;
  return new TextDecoder().decode(entry.plaintext);
}

export interface NoticesViewProps {
  notices: readonly NoticeBoardEntry[];
}

export function NoticesView({
  notices,
}: Readonly<NoticesViewProps>): React.JSX.Element | null {
  if (notices.length === 0) {
    return null;
  }
  const items = notices.map((entry, index) => {
    const text = textOf(entry);
    return (
      <Box key={index}>
        {text !== undefined ? (
          <Text size="sm">{text}</Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">
            encrypted notice -- no key held for its epoch
          </Text>
        )}
      </Box>
    );
  });
  return (
    <Stack gap={4}>
      {items}
      <Badge variant="light" color="gray" size="sm" w="fit-content">
        {notices.length} notice{notices.length === 1 ? "" : "s"}
      </Badge>
    </Stack>
  );
}
