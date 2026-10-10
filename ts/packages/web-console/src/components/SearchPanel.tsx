// Search box and results over every conversation's messages and notices. A result names its conversation, says whether it is a message or a notice, highlights what matched, and opens that conversation when clicked. The matching itself is search.ts; this only renders it.

import { useState } from "react";
import {
  Badge,
  Group,
  Highlight,
  NavLink,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { participantLabel } from "../conversations.js";
import type { ConversationView } from "../conversations.js";
import { usePeerNames } from "../hooks/use-peer-names.js";
import { queryTerms, searchConversations } from "../search.js";

export interface SearchPanelProps {
  conversations: readonly ConversationView[];
  onSelect: (roomPath: string) => void;
}

export function SearchPanel({
  conversations,
  onSelect,
}: Readonly<SearchPanelProps>): React.JSX.Element | null {
  const names = usePeerNames();
  const [query, setQuery] = useState("");
  if (conversations.length === 0) {
    return null;
  }
  const results = searchConversations(conversations, query);
  const searching = queryTerms(query).length > 0;
  const conversationOf = new Map(
    conversations.map((conversation) => [conversation.roomPath, conversation]),
  );

  return (
    <Stack gap="xs" data-testid="search-panel">
      <TextInput
        type="search"
        label="Search conversations and notices"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
        }}
      />
      {searching && results.length === 0 && (
        <Text size="sm" c="dimmed">
          Nothing matches.
        </Text>
      )}
      {results.map((result) => {
        const conversation = conversationOf.get(result.roomPath);

        return (
          <NavLink
            key={result.key}
            label={
              <Highlight highlight={queryTerms(query)} size="sm">
                {result.text}
              </Highlight>
            }
            description={
              <Group gap="xs">
                <Badge size="xs" variant="light">
                  {result.kind}
                </Badge>
                <Text size="xs" c="dimmed">
                  {conversation === undefined
                    ? result.roomPath
                    : participantLabel(conversation, names)}
                  {" · "}
                  {new Date(result.at).toLocaleString()}
                </Text>
              </Group>
            }
            onClick={() => {
              onSelect(result.roomPath);
            }}
          />
        );
      })}
    </Stack>
  );
}
