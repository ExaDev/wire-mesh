// This device's identity as the console knows it, and the ceremony around losing or moving it. Exporting writes the private key into a file the person saves; it asks first, says what the file is, and never shows the key. Restoring replaces this device's identity, names both before it does, and takes effect on the next load.

import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Code,
  CopyButton,
  FileButton,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import {
  parseIdentityBackup,
  type IdentityBackup,
  type IdentityBackupService,
} from "../adapters/identity-backup.js";
import { saveTextFile } from "../save-file.js";

const BACKUP_FILENAME = "wire-mesh-console-identity.json";
const JSON_INDENT = 2;

export interface IdentityPanelProps {
  identity: Readonly<IdentityPort>;
  backup: IdentityBackupService;
  /** Saves the backup file. Defaults to the browser's download flow. */
  save?: (filename: string, text: string) => void;
  /** Reloads the console so a restored identity is the one it runs as. Defaults to reloading the page. */
  reload?: () => void;
}

type Step =
  | { kind: "idle" }
  | { kind: "confirm-export" }
  | { kind: "exported" }
  | { kind: "confirm-restore"; backup: IdentityBackup }
  | { kind: "restored" }
  | { kind: "error"; message: string };

function reloadPage(): void {
  location.reload();
}

export function IdentityPanel({
  identity,
  backup,
  save = saveTextFile,
  reload = reloadPage,
}: Readonly<IdentityPanelProps>): React.JSX.Element {
  const deviceHex = deviceIdToHex(identity.deviceId);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [understood, setUnderstood] = useState(false);

  async function exportBackup(): Promise<void> {
    try {
      save(
        BACKUP_FILENAME,
        JSON.stringify(await backup.export(), undefined, JSON_INDENT),
      );
      setStep({ kind: "exported" });
    } catch (error) {
      setStep({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function chooseBackup(file: File | null): Promise<void> {
    if (file === null) return;
    try {
      setStep({
        kind: "confirm-restore",
        backup: await parseIdentityBackup(await file.text()),
      });
    } catch (error) {
      setStep({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <Stack gap="xs" data-testid="identity-panel">
      <Text size="sm">
        This device is <Code data-testid="own-device-id">{deviceHex}</Code>{" "}
        <CopyButton value={deviceHex}>
          {({ copied, copy }) => (
            <Button size="compact-xs" variant="subtle" onClick={copy}>
              {copied ? "Copied" : "Copy device id"}
            </Button>
          )}
        </CopyButton>
      </Text>
      <Text size="sm" c="dimmed">
        Its key is ES256 (P-256) and lives in this browser. If this
        browser&apos;s storage is cleared or the device is lost, the identity is
        gone, along with every grant made to it. A backup file lets you keep it.
      </Text>

      {step.kind === "confirm-export" && (
        <Alert color="orange" title="This file holds your private key">
          <Stack gap="xs">
            <Text size="sm">
              Anyone who has it can act as this device. Save it somewhere
              private, and do not send it to anyone. The console does not show
              the key or keep a copy of the file.
            </Text>
            <Checkbox
              label="I understand, and I want a backup file"
              checked={understood}
              onChange={(event) => {
                setUnderstood(event.currentTarget.checked);
              }}
            />
            <Group>
              <Button
                size="xs"
                color="orange"
                disabled={!understood}
                onClick={() => {
                  void exportBackup();
                }}
              >
                Save backup file
              </Button>
              <Button
                size="xs"
                variant="light"
                onClick={() => {
                  setStep({ kind: "idle" });
                }}
              >
                Cancel
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      {step.kind === "exported" && (
        <Alert color="green" title="Backup file saved">
          Keep it private. Restoring it on another browser makes that browser
          this device.
        </Alert>
      )}

      {step.kind === "confirm-restore" && (
        <Alert color="red" title="Replace this device's identity?">
          <Stack gap="xs">
            <Text size="sm">
              This device is now <Code>{deviceHex}</Code>. The backup is{" "}
              <Code>{step.backup.deviceId}</Code>. Restoring makes this browser
              the backup&apos;s device the next time the console loads, and this
              identity, with the grants made to it, is gone unless you have a
              backup of it.
            </Text>
            <Group>
              <Button
                size="xs"
                color="red"
                onClick={() => {
                  void backup.restore(step.backup).then(() => {
                    setStep({ kind: "restored" });
                  });
                }}
              >
                Replace this identity
              </Button>
              <Button
                size="xs"
                variant="light"
                onClick={() => {
                  setStep({ kind: "idle" });
                }}
              >
                Cancel
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      {step.kind === "restored" && (
        <Alert color="green" title="Identity restored">
          <Stack gap="xs">
            <Text size="sm">
              Reload the console to run as the restored identity.
            </Text>
            <Button size="xs" w="fit-content" onClick={reload}>
              Reload now
            </Button>
          </Stack>
        </Alert>
      )}

      {step.kind === "error" && (
        <Alert color="red" title="That did not work">
          {step.message}
        </Alert>
      )}

      {(step.kind === "idle" ||
        step.kind === "exported" ||
        step.kind === "error") && (
        <Group>
          <Button
            size="xs"
            variant="light"
            onClick={() => {
              setUnderstood(false);
              setStep({ kind: "confirm-export" });
            }}
          >
            Back up this identity
          </Button>
          <FileButton
            accept="application/json,.json"
            onChange={(file) => {
              void chooseBackup(file);
            }}
          >
            {(props) => (
              <Button size="xs" variant="light" color="red" {...props}>
                Restore from a backup file
              </Button>
            )}
          </FileButton>
        </Group>
      )}
    </Stack>
  );
}
