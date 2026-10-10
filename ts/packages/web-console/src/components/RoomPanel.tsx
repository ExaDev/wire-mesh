// One conversation's own UI: message history, a compose box, and (when the peer has asked to message this console) an inline approve/deny prompt. All room-protocol behaviour lives in room-client.ts and the useRoomMessaging hook; this component only renders a ConversationView and forwards clicks back onto it.

import { Alert, Button, Divider, Group, Stack, Text } from "@mantine/core";
import { SubmitRow } from "web-ui-primitives";
import { participantLabel, type ConversationView } from "../conversations.js";
import { usePeerNames } from "../hooks/use-peer-names.js";
import { PeerName } from "./PeerName.js";
import { MessageList } from "./MessageList.js";
import { NoticesView } from "./NoticesView.js";

// How long an approved room:member grant lasts before the recipient must request-to-join again -- a session-length default, not a protocol requirement; re-requesting is cheap (an ordinary ungated room.join) so erring short over long costs little.
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const ROOM_TOKEN_LIFETIME_MS =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

export interface RoomPanelProps {
  view: Readonly<ConversationView>;
  onSend: (text: string) => Promise<void>;
  onPostNotice: (text: string) => Promise<void>;
  onRetry: (localId: string) => void;
  onDiscard: (localId: string) => void;
}

/** How the conversation is reaching its peer, in the words the header shows. */
function routeLabel(via: ConversationView["via"]): string {
  if (via === "direct") return "direct";
  if (via === "hub") return "via hub";

  return "offline";
}

export function RoomPanel({
  view,
  onSend,
  onPostNotice,
  onRetry,
  onDiscard,
}: Readonly<RoomPanelProps>): React.JSX.Element {
  const names = usePeerNames();

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text fw={600} data-testid="conversation-header">
          {participantLabel(view, names)}
        </Text>
        <Text size="sm" c={view.status === "connected" ? "green" : "dimmed"}>
          {routeLabel(view.via)}
        </Text>
      </Group>

      {view.pendingJoinRequest && (
        <Alert color="blue" title="Message request">
          <Group justify="space-between">
            <Text size="sm">
              <PeerName deviceHex={view.pendingJoinRequest.requesterHex} />{" "}
              wants to message you
            </Text>
            <Group>
              <Button
                size="xs"
                onClick={() => {
                  void view.pendingJoinRequest?.decide({
                    kind: "accept",
                    capability: "room:member",
                    expires: Date.now() + ROOM_TOKEN_LIFETIME_MS,
                  });
                }}
              >
                Allow
              </Button>
              <Button
                size="xs"
                color="red"
                variant="light"
                onClick={() => {
                  void view.pendingJoinRequest?.decide({ kind: "reject" });
                }}
              >
                Deny
              </Button>
            </Group>
          </Group>
        </Alert>
      )}

      <MessageList
        messages={view.messages}
        outgoing={view.outgoing}
        peerLabel={participantLabel(view, names)}
        onRetry={onRetry}
        onDiscard={onDiscard}
      />

      <Group>
        <SubmitRow
          ariaLabel="Message"
          placeholder="Message"
          submitLabel="Send"
          onSubmit={onSend}
        />
      </Group>

      <Divider
        label="Durable notices (encrypted, replicated)"
        labelPosition="center"
      />
      <NoticesView notices={view.notices} />
      {view.via !== undefined ? (
        <Group>
          <SubmitRow
            ariaLabel="Post a durable notice"
            placeholder="Post a durable notice"
            submitLabel="Post notice"
            onSubmit={onPostNotice}
          />
        </Group>
      ) : (
        <Text size="sm" c="dimmed">
          Durable notices can be posted while the conversation is connected.
        </Text>
      )}
    </Stack>
  );
}
