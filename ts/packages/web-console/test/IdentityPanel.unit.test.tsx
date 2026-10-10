// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import {
  createIdentityBackupService,
  parseIdentityBackup,
} from "../src/adapters/identity-backup.js";
import { createPersistedWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { IdentityPanel } from "../src/components/IdentityPanel.js";
import { WithNames } from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

type Save = (filename: string, text: string) => void;

const STORAGE_FAILURE = "the origin's storage quota is exhausted";

interface Rendered {
  storage: ReturnType<typeof createMemoryStorage>;
  identity: IdentityPort;
  save: ReturnType<typeof vi.fn<Save>>;
  reload: ReturnType<typeof vi.fn<() => void>>;
}

async function renderPanel(): Promise<Rendered> {
  const storage = createMemoryStorage();
  const identity = await createPersistedWebCryptoIdentity(storage);
  const save = vi.fn<Save>();
  const reload = vi.fn<() => void>();
  render(
    <WithNames>
      <IdentityPanel
        identity={identity}
        backup={createIdentityBackupService(storage)}
        save={save}
        reload={reload}
      />
    </WithNames>,
  );

  return { storage, identity, save, reload };
}

function chooseFile(contents: string): void {
  const input = document.querySelector('input[type="file"]');
  if (input === null) throw new Error("expected a file input");
  fireEvent.change(input, {
    target: {
      files: [
        new File([contents], "backup.json", { type: "application/json" }),
      ],
    },
  });
}

describe("IdentityPanel", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows this device's id", async () => {
    const { identity } = await renderPanel();

    expect(screen.getByTestId("own-device-id")).toHaveTextContent(
      deviceIdToHex(identity.deviceId),
    );
  });

  it("saves a backup only after the warning is acknowledged, and never shows or logs the key", async () => {
    const { save } = await renderPanel();
    const logged = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
    ];

    fireEvent.click(
      screen.getByRole("button", { name: "Back up this identity" }),
    );
    expect(
      screen.getByText("This file holds your private key"),
    ).toBeInTheDocument();
    const saveButton = screen.getByRole("button", { name: "Save backup file" });
    expect(saveButton).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/I understand/));
    fireEvent.click(saveButton);

    await screen.findByText("Backup file handed to your browser");
    expect(save).toHaveBeenCalledTimes(1);
    const [filename, text] = save.mock.calls[0] ?? [];
    expect(filename).toBe("wire-mesh-console-identity.json");
    const privateScalar = (await parseIdentityBackup(text ?? "")).privateJwk.d;
    if (typeof privateScalar !== "string") {
      throw new Error("expected the backup to carry the private scalar");
    }
    expect(document.body.textContent).not.toContain(privateScalar);
    for (const spy of logged) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(privateScalar);
    }
  });

  it("saves nothing when the backup is cancelled", async () => {
    const { save } = await renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "Back up this identity" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(save).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Back up this identity" }),
    ).toBeInTheDocument();
  });

  it("restores another identity only after naming both, then offers a reload", async () => {
    const { storage, identity, reload, save } = await renderPanel();
    const donor = createMemoryStorage();
    const donorIdentity = await createPersistedWebCryptoIdentity(donor);
    const backup = await createIdentityBackupService(donor).export();

    chooseFile(JSON.stringify(backup));

    await screen.findByText("Replace this device's identity?");
    expect(screen.getByText(backup.deviceId)).toBeInTheDocument();
    expect(
      await createPersistedWebCryptoIdentity(storage).then((loaded) =>
        deviceIdToHex(loaded.deviceId),
      ),
    ).toBe(deviceIdToHex(identity.deviceId));

    fireEvent.click(
      screen.getByRole("button", { name: "Replace this identity" }),
    );

    await screen.findByText("Identity restored");
    expect(
      deviceIdToHex((await createPersistedWebCryptoIdentity(storage)).deviceId),
    ).toBe(deviceIdToHex(donorIdentity.deviceId));
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves the identity alone when the restore is cancelled", async () => {
    const { storage, identity } = await renderPanel();
    const donor = createMemoryStorage();
    await createPersistedWebCryptoIdentity(donor);
    chooseFile(
      JSON.stringify(await createIdentityBackupService(donor).export()),
    );
    await screen.findByText("Replace this device's identity?");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      deviceIdToHex((await createPersistedWebCryptoIdentity(storage)).deviceId),
    ).toBe(deviceIdToHex(identity.deviceId));
  });

  it("says what is wrong with a file that is not a backup", async () => {
    await renderPanel();

    chooseFile("not json");

    await screen.findByText("the file is not JSON");
  });

  it("says so, and keeps the identity, when the restore cannot be written", async () => {
    const storage = createMemoryStorage();
    const identity = await createPersistedWebCryptoIdentity(storage);
    const donor = createMemoryStorage();
    await createPersistedWebCryptoIdentity(donor);
    const real = createIdentityBackupService(storage);
    render(
      <WithNames>
        <IdentityPanel
          identity={identity}
          backup={{
            ...real,
            restore: async () => Promise.reject(new Error(STORAGE_FAILURE)),
          }}
          save={vi.fn<Save>()}
          reload={vi.fn<() => void>()}
        />
      </WithNames>,
    );
    chooseFile(
      JSON.stringify(await createIdentityBackupService(donor).export()),
    );
    await screen.findByText("Replace this device's identity?");

    fireEvent.click(
      screen.getByRole("button", { name: "Replace this identity" }),
    );

    expect(await screen.findByText(STORAGE_FAILURE)).toBeInTheDocument();
    expect(screen.queryByText("Identity restored")).toBeNull();
    expect(
      deviceIdToHex((await createPersistedWebCryptoIdentity(storage)).deviceId),
    ).toBe(deviceIdToHex(identity.deviceId));
  });
});
