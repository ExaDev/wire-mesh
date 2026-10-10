// What the user sees at the trust moments: a first-use confirmation naming the node and its certificate, a warning when an address presents a different certificate than the remembered one, and a notice when a connected node announces certificates unrelated to the remembered ones. Decisions are reported upward; nothing here touches storage or a session.

import { Alert, Button, Code, Group, Stack, Text } from "@mantine/core";
import { formatFingerprint } from "../certificate-trust.js";
import type {
  NodeCertificateChange,
  TrustPrompt,
} from "../hooks/use-certificate-trust.js";

function Fingerprints({
  label,
  hashes,
}: Readonly<{ label: string; hashes: readonly string[] }>): React.JSX.Element {
  return (
    <div>
      <Text size="sm" fw={600}>
        {label}
      </Text>
      {hashes.map((hash) => (
        <Code key={hash} block>
          {formatFingerprint(hash)}
        </Code>
      ))}
    </div>
  );
}

function PromptAlert({
  prompt,
}: Readonly<{ prompt: TrustPrompt }>): React.JSX.Element {
  const { assessment, decide } = prompt;
  const changed = assessment.kind === "changed";

  return (
    <Alert
      color={changed ? "red" : "blue"}
      title={
        changed
          ? `Certificate changed for ${assessment.node}`
          : `First connection to ${assessment.node}`
      }
      data-testid="certificate-prompt"
    >
      <Stack gap="xs">
        <Text size="sm">
          {changed
            ? "This address presents a certificate that shares nothing with the one remembered for this node. The node may have replaced its certificate, or something else may be answering at this address. Only continue if you expected the change."
            : "This console has not connected to this node before. Connecting pins the certificate below as the one to expect from it from now on. Compare it with what the node's operator reports before you trust it."}
        </Text>
        {changed && (
          <Fingerprints label="Remembered" hashes={assessment.remembered} />
        )}
        <Fingerprints
          label={changed ? "Presented now" : "Certificate (SHA-256)"}
          hashes={assessment.presented}
        />
        <Group>
          <Button
            size="xs"
            color={changed ? "red" : "blue"}
            onClick={() => {
              decide(true);
            }}
          >
            {changed ? "Trust the new certificate" : "Trust and connect"}
          </Button>
          <Button
            size="xs"
            variant="light"
            onClick={() => {
              decide(false);
            }}
          >
            Cancel
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}

export interface CertificateTrustPanelProps {
  prompts: readonly TrustPrompt[];
  changes: readonly NodeCertificateChange[];
  onDismissChange: (key: string) => void;
}

export function CertificateTrustPanel({
  prompts,
  changes,
  onDismissChange,
}: Readonly<CertificateTrustPanelProps>): React.JSX.Element | null {
  const undismissed = changes.filter((change) => !change.dismissed);
  if (prompts.length === 0 && undismissed.length === 0) {
    return null;
  }

  return (
    <Stack gap="sm" data-testid="certificate-trust">
      {prompts.map((prompt) => (
        <PromptAlert key={prompt.key} prompt={prompt} />
      ))}
      {undismissed.map((change) => (
        <Alert
          key={change.key}
          color="red"
          title={`${change.node} announced different certificates`}
          withCloseButton
          closeButtonLabel="Dismiss"
          onClose={() => {
            onDismissChange(change.key);
          }}
        >
          <Stack gap="xs">
            <Text size="sm">
              The node is still reachable through the certificate you pinned,
              but it now announces certificates that share nothing with the ones
              remembered for it, and the announced set is what this console will
              pin from now on.
            </Text>
            <Fingerprints label="Remembered" hashes={change.remembered} />
            <Fingerprints label="Announced" hashes={change.presented} />
          </Stack>
        </Alert>
      ))}
    </Stack>
  );
}
