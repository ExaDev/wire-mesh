// The first-run walkthrough: how to connect, who the directory shows, why a discovered peer waits for an explicit connect, and what works offline. Dismissing it is remembered by the caller; it can be brought back from the header.

import { Button, Card, List, Text, Title } from "@mantine/core";

export interface OnboardingIntroProps {
  onDismiss: () => void;
}

export function OnboardingIntro({
  onDismiss,
}: Readonly<OnboardingIntroProps>): React.JSX.Element {
  return (
    <Card withBorder padding="md" radius="md" data-testid="onboarding-intro">
      <Title order={2} size="h4" mb="xs">
        Welcome to the wire-mesh console
      </Title>
      <List type="ordered" spacing="xs" size="sm">
        <List.Item>
          <Text span fw={600}>
            Connect.
          </Text>{" "}
          Enter a node&apos;s address in the Node field and press Connect. A
          console served by a node starts with that node&apos;s address filled
          in, so there is usually nothing to type. The status line shows the
          connection coming up.
        </List.Item>
        <List.Item>
          <Text span fw={600}>
            See who is here.
          </Text>{" "}
          Once connected, the node&apos;s peer directory lists the devices it
          knows. Message opens a conversation with one. Devices appear under the
          name they chose for themselves, or a short id; use the pencil beside a
          device to give it a name of your own, which only this console keeps.
        </List.Item>
        <List.Item>
          <Text span fw={600}>
            Discovered peers wait for you.
          </Text>{" "}
          A node you are connected to can tell you about other nodes. Nothing
          vouches for those addresses except the node that listed them, and one
          may not be a wire-mesh node at all, so the console never dials one by
          itself. Each waits in the Discovered peers list until you press
          Connect or dismiss it.
        </List.Item>
        <List.Item>
          <Text span fw={600}>
            Offline.
          </Text>{" "}
          The console itself loads without a network, and conversations are kept
          on this device, so history stays readable. Sending needs a route to
          the peer, through a node or directly; a message that could not be sent
          stays with its reason until you retry or dismiss it.
        </List.Item>
      </List>
      <Button mt="md" size="xs" onClick={onDismiss}>
        Got it
      </Button>
    </Card>
  );
}
