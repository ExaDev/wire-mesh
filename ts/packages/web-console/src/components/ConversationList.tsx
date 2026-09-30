// The list of every conversation this console holds, live or restored from storage: one row per room path, with its unread count and, when a peer is waiting on this console's decision, a marker that the row needs attention even if it is not the selected conversation. Selection is owned by the caller; this component only renders rows and reports clicks.

import { Badge, Group, NavLink, Stack, Text } from "@mantine/core";
import { participantLabel, type ConversationView } from "../conversations.js";
import { usePeerNames } from "../hooks/use-peer-names.js";

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
  const names = usePeerNames();
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
          label={participantLabel(
            conversation,
            (hex) => names.labelOf(hex).primary,
          )}
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
