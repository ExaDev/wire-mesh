// A conversation's history and its unsent messages: each message with its time, a sender label at the start of each run from one side, the newest kept in view, and any message that is still sending or failed shown after the history with its reason and retry and dismiss actions.

import { useEffect, useRef } from "react";
import { Button, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import type { PendingOutgoing } from "../conversations.js";
import type { StoredMessage } from "../message-store.js";

const OWN_LABEL = "You";
const MESSAGE_LIST_HEIGHT_PX = 256;
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

export interface MessageListProps {
  messages: readonly StoredMessage[];
  outgoing: readonly PendingOutgoing[];
  /** How the other side is named above a run of received messages. */
  peerLabel: string;
  onRetry: (localId: string) => void;
  onDiscard: (localId: string) => void;
}

function MessageTime({
  sentAt,
}: Readonly<{ sentAt: number }>): React.JSX.Element {
  return (
    <Text
      component="time"
      size="xs"
      c="dimmed"
      dateTime={new Date(sentAt).toISOString()}
    >
      {timeFormat.format(sentAt)}
    </Text>
  );
}

export function MessageList({
  messages,
  outgoing,
  peerLabel,
  onRetry,
  onDiscard,
}: Readonly<MessageListProps>): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);

  // The newest entry, sent or received or still pending, is kept in view. Depends on the lists themselves, so a change in either scrolls.
  useEffect(() => {
    const element = viewport.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, outgoing]);

  return (
    <ScrollArea h={MESSAGE_LIST_HEIGHT_PX} viewportRef={viewport}>
      <Stack gap={4}>
        {messages.map((message, index) => {
          const sent = message.direction === "sent";
          const startsRun =
            index === 0 || messages[index - 1]?.direction !== message.direction;
          return (
            <Stack
              key={bytesToHex(message.messageId)}
              gap={0}
              align={sent ? "flex-end" : "flex-start"}
              mt={startsRun ? "xs" : 0}
            >
              {startsRun && (
                <Text size="xs" fw={600} c="dimmed">
                  {sent ? OWN_LABEL : peerLabel}
                </Text>
              )}
              <Text size="sm">{message.text}</Text>
              <MessageTime sentAt={message.sentAt} />
            </Stack>
          );
        })}
        {outgoing.map((pending) => (
          <Stack key={pending.localId} gap={0} align="flex-end" mt="xs">
            <Text size="xs" fw={600} c="dimmed">
              {OWN_LABEL}
            </Text>
            <Text size="sm" c="dimmed">
              {pending.text}
            </Text>
            {pending.status === "failed" ? (
              <Group gap="xs">
                <Text size="xs" c="red">
                  {`Not sent: ${pending.error}`}
                </Text>
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() => {
                    onRetry(pending.localId);
                  }}
                >
                  Retry
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => {
                    onDiscard(pending.localId);
                  }}
                >
                  Dismiss
                </Button>
              </Group>
            ) : (
              <Text size="xs" c="dimmed">
                {pending.status === "awaiting-approval"
                  ? `Waiting for ${peerLabel} to allow messages`
                  : "Sending"}
              </Text>
            )}
          </Stack>
        ))}
      </Stack>
    </ScrollArea>
  );
}
