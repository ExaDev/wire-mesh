// The list of every conversation this console holds, live or restored from storage: one row per room path, with its unread count and, when a peer is waiting on this console's decision, a marker that the row needs attention even if it is not the selected conversation. Selection is owned by the caller; this component only renders rows and reports clicks.

import { Badge, Group, NavLink, Stack, Text } from "@mantine/core";
import type { ConversationView } from "../conversations.js";

/** How many leading hex characters of a device-id label a row: enough to tell devices apart at a glance, while the panel of the selected conversation shows the full id. */
const DEVICE_LABEL_LENGTH = 12;

export function conversationLabel(
  view: Readonly<Pick<ConversationView, "participants" | "roomPath">>,
): string {
  if (view.participants.length === 0) return view.roomPath;
  return view.participants
    .map((hex) => hex.slice(0, DEVICE_LABEL_LENGTH))
    .join(", ");
}

export interface ConversationListProps {
  conversations: readonly ConversationView[];
  selected: string | undefined;
  onSelect: (roomPath: string) => void;
}

export function ConversationList({
  conversations,
  selected,
  onSelect,
}: Readonly<ConversationListProps>): React.JSX.Element | null {
  if (conversations.length === 0) {
    return null;
  }
  return (
    <Stack gap={0} data-testid="conversation-list">
      <Text fw={600} size="sm" mb="xs">
        Conversations
      </Text>
      {conversations.map((conversation) => (
        <NavLink
          key={conversation.roomPath}
          active={conversation.roomPath === selected}
          label={conversationLabel(conversation)}
          description={
            conversation.status === "connected" ? undefined : "offline"
          }
          rightSection={
            <Group gap={4} wrap="nowrap">
              {conversation.pendingJoinRequest !== undefined && (
                <Badge color="blue" size="sm">
                  request
                </Badge>
              )}
              {conversation.unread > 0 && (
                <Badge
                  size="sm"
                  aria-label={`${String(conversation.unread)} unread`}
                >
                  {conversation.unread}
                </Badge>
              )}
            </Group>
          }
          onClick={() => {
            onSelect(conversation.roomPath);
          }}
        />
      ))}
    </Stack>
  );
}
