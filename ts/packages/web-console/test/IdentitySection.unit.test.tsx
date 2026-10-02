// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { RevocationEntry } from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createIdentityBackupService } from "../src/adapters/identity-backup.js";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { IdentitySection } from "../src/components/IdentitySection.js";
import type { AnnounceResult } from "../src/hooks/use-grants.js";
import { encodeGrantCode } from "../src/grants.js";
import { mintGrant } from "../src/mint-grant.js";
import { testCapabilities } from "./capability-services.js";
import type { TestCapabilities } from "./capability-services.js";
import { WithNames } from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const NOW = 1000;
const HOURS = 24;
const clock = { now: () => NOW };

let own: IdentityPort;
let other: IdentityPort;
let capabilities: TestCapabilities;
const announce = vi.fn<(entry: RevocationEntry) => Promise<AnnounceResult>>(
  async () => Promise.resolve({ attempted: 1, reached: 1 }),
);

beforeAll(async () => {
  own = await createWebCryptoIdentity();
  other = await createWebCryptoIdentity();
});

beforeEach(async () => {
  stubMantineJsdomGlobals();
  capabilities = await testCapabilities(own, clock);
  announce.mockReset();
  announce.mockResolvedValue({ attempted: 1, reached: 1 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSection(
  backupStorage = createMemoryStorage(),
): ReturnType<typeof render> {
  return render(
    <WithNames>
      <IdentitySection
        identity={own}
        clock={clock}
        grants={capabilities.grants}
        revocations={capabilities.revocations}
        identityBackup={createIdentityBackupService(backupStorage)}
        announceRevocation={announce}
      />
    </WithNames>,
  );
}

async function openGrants(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Grants" }));
  await waitFor(() => {
    expect(screen.getByTestId("grants-panel")).toBeVisible();
  });
}

/** A code another device would copy, for a grant it made to `bearer`. */
async function codeFrom(
  issuer: IdentityPort,
  bearer: IdentityPort,
): Promise<string> {
  const minted = await mintGrant(
    {
      bearerHex: deviceIdToHex(bearer.deviceId),
      capability: "room:member",
      scopeKind: "room",
      scopePath: "a-room",
      lifetimeHours: HOURS,
      delegationsRemaining: undefined,
      parent: undefined,
    },
    { identity: issuer, clock },
  );
  if (!minted.ok) throw new Error(minted.error);
  return encodeGrantCode(minted.token);
}

function fillMintForm(bearerHex: string): void {
  fireEvent.change(screen.getByLabelText(/^Bearer device-id/), {
    target: { value: bearerHex },
  });
  fireEvent.change(screen.getByRole("combobox", { name: /^Capability/ }), {
    target: { value: "room:member" },
  });
  fireEvent.change(screen.getByLabelText(/^Scope path/), {
    target: { value: "a-room" },
  });
}

describe("grants", () => {
  it("mints a grant, lists it as issued and valid, and shows a grant code on inspection", async () => {
    renderSection();
    await openGrants();
    fillMintForm(deviceIdToHex(other.deviceId));

    fireEvent.click(screen.getByRole("button", { name: "Mint grant" }));

    await screen.findByText("Grant minted");
    const issued = await screen.findByTestId("grants-issued");
    // The issued list is rendered before the minted grant reaches it, so each assertion waits for its own content rather than reading it once.
    expect(await within(issued).findByText("room:member")).toBeInTheDocument();
    expect(await within(issued).findByText("valid")).toBeInTheDocument();
    fireEvent.click(
      await within(issued).findByRole("button", { name: "Inspect" }),
    );
    const code = await within(issued).findByLabelText("Grant code");
    if (!(code instanceof HTMLTextAreaElement)) {
      throw new Error("expected the grant code in a textarea");
    }
    expect(code.value).toMatch(/^wm-grant1\./);
  });

  it("says why a grant was not minted", async () => {
    renderSection();
    await openGrants();
    fillMintForm("not-a-device");

    fireEvent.click(screen.getByRole("button", { name: "Mint grant" }));

    await screen.findByText(/must be a 64-character hex device-id/);
    expect(
      within(screen.getByTestId("grants-issued")).getByText("None."),
    ).toBeInTheDocument();
  });

  it("revokes an issued grant only after confirmation, announces it, and shows it revoked", async () => {
    renderSection();
    await openGrants();
    fillMintForm(deviceIdToHex(other.deviceId));
    fireEvent.click(screen.getByRole("button", { name: "Mint grant" }));
    const issued = await screen.findByTestId("grants-issued");
    await within(issued).findByText("valid");

    fireEvent.click(within(issued).getByRole("button", { name: "Revoke" }));
    expect(announce).not.toHaveBeenCalled();
    fireEvent.click(
      within(issued).getByRole("button", { name: /^Confirm: revoke/ }),
    );

    await within(issued).findByText("revoked");
    expect(announce).toHaveBeenCalledTimes(1);
    expect(within(issued).queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  async function revokeOneIssuedGrant(): Promise<void> {
    renderSection();
    await openGrants();
    fillMintForm(deviceIdToHex(other.deviceId));
    fireEvent.click(screen.getByRole("button", { name: "Mint grant" }));
    const issued = await screen.findByTestId("grants-issued");
    await within(issued).findByText("valid");
    fireEvent.click(within(issued).getByRole("button", { name: "Revoke" }));
    fireEvent.click(
      within(issued).getByRole("button", { name: /^Confirm: revoke/ }),
    );
  }

  it("says how many nodes a revocation reached", async () => {
    announce.mockResolvedValue({ attempted: 3, reached: 2 });

    await revokeOneIssuedGrant();

    const report = await screen.findByTestId("revocation-report");
    expect(report).toHaveTextContent("Revoked, but not every node was told");
    expect(report).toHaveTextContent("Sent to 2 of 3 connected nodes");
  });

  it("says when no connection was open to tell, since the revocation is then recorded here only", async () => {
    announce.mockResolvedValue({ attempted: 0, reached: 0 });

    await revokeOneIssuedGrant();

    const report = await screen.findByTestId("revocation-report");
    expect(report).toHaveTextContent("Revoked here only");
    expect(report).toHaveTextContent("No connection was open");
  });

  it("confirms a revocation that reached every connected node", async () => {
    await revokeOneIssuedGrant();

    expect(await screen.findByTestId("revocation-report")).toHaveTextContent(
      "Sent to 1 connected node.",
    );
  });

  it("reads a held grant that names another device as invalid, as after an identity restore", async () => {
    const minted = await mintGrant(
      {
        bearerHex: deviceIdToHex(other.deviceId),
        capability: "room:member",
        scopeKind: "room",
        scopePath: "a-room",
        lifetimeHours: HOURS,
        delegationsRemaining: undefined,
        parent: undefined,
      },
      { identity: other, clock },
    );
    if (!minted.ok) throw new Error(minted.error);
    await capabilities.grants.record("held", minted.token, NOW);
    renderSection();

    await openGrants();

    const held = await screen.findByTestId("grants-held");
    expect(await within(held).findByText(/names another bearer/)).toBeVisible();
  });

  it("adds a grant made to this device from its code, listed as held", async () => {
    renderSection();
    await openGrants();

    fireEvent.change(screen.getByLabelText(/^Grant code/), {
      target: { value: await codeFrom(other, own) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add grant" }));

    await screen.findByText("Grant added");
    const held = await screen.findByTestId("grants-held");
    expect(within(held).getByText("room:member")).toBeInTheDocument();
    expect(within(held).getByText("valid")).toBeInTheDocument();
  });

  it("refuses a grant code made to another device", async () => {
    renderSection();
    await openGrants();

    fireEvent.change(screen.getByLabelText(/^Grant code/), {
      target: { value: await codeFrom(other, other) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add grant" }));

    await screen.findByText(/names another bearer/);
    expect(
      within(screen.getByTestId("grants-held")).getByText("None."),
    ).toBeInTheDocument();
  });

  it("refuses text that is not a grant code", async () => {
    renderSection();
    await openGrants();

    fireEvent.change(screen.getByLabelText(/^Grant code/), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add grant" }));

    await screen.findByText(/starts with "wm-grant1\."/);
  });

  it("shows a grant revoked by its issuer as revoked once the revocation arrives", async () => {
    renderSection();
    await openGrants();
    fireEvent.change(screen.getByLabelText(/^Grant code/), {
      target: { value: await codeFrom(other, own) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add grant" }));
    const held = await screen.findByTestId("grants-held");
    await within(held).findByText("valid");

    const [record] = await capabilities.grants.list();
    if (record === undefined) throw new Error("expected a held grant");
    const { mintRevocationEntry } =
      await import("wire-mesh-core/domain/tokens");
    await capabilities.revocations.ingest(
      await mintRevocationEntry({
        identity: other,
        tokenId: record.claims["token-id"],
        revokedAt: NOW,
      }),
    );

    await within(held).findByText("revoked");
  });
});
