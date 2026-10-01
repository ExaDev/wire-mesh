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
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { MintGrantForm } from "../src/components/MintGrantForm.js";
import type { GrantRow } from "../src/hooks/use-grants.js";
import { decodeGrantClaims } from "../src/grants.js";
import { mintGrant } from "../src/mint-grant.js";
import type { MintGrantInput } from "../src/mint-grant.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const NOW = 1000;
const DAY_HOURS = 24;
const clock = { now: () => NOW };
const STORAGE_FAILURE = "the origin's storage quota is exhausted";

let issuer: IdentityPort;
let holder: IdentityPort;

beforeAll(async () => {
  issuer = await createWebCryptoIdentity();
  holder = await createWebCryptoIdentity();
});

async function heldRow(): Promise<GrantRow> {
  const minted = await mintGrant(
    {
      bearerHex: deviceIdToHex(holder.deviceId),
      capability: "room:member",
      scopeKind: "room",
      scopePath: "a-room",
      lifetimeHours: DAY_HOURS,
      delegationsRemaining: 1,
      parent: undefined,
    },
    { identity: issuer, clock },
  );
  if (!minted.ok) throw new Error(minted.error);
  const claims = decodeGrantClaims(minted.token);
  if (claims === undefined) throw new Error("minted token has no claims");
  return {
    tokenId: "held-1",
    direction: "held",
    token: minted.token,
    claims,
    recordedAt: NOW,
    status: { kind: "valid" },
  };
}

/** A valid manage:grant this device holds, which a mint can cite as its authoriser. */
async function heldGrantRow(): Promise<GrantRow> {
  const minted = await mintGrant(
    {
      bearerHex: deviceIdToHex(holder.deviceId),
      capability: "manage:grant",
      scopeKind: "folder",
      scopePath: "/work",
      lifetimeHours: DAY_HOURS,
      delegationsRemaining: undefined,
      parent: undefined,
    },
    { identity: issuer, clock },
  );
  if (!minted.ok) throw new Error(minted.error);
  const claims = decodeGrantClaims(minted.token);
  if (claims === undefined) throw new Error("minted token has no claims");
  return {
    tokenId: "held-grant-1",
    direction: "held",
    token: minted.token,
    claims,
    recordedAt: NOW,
    status: { kind: "valid" },
  };
}

type OnMint = React.ComponentProps<typeof MintGrantForm>["onMint"];

function recordingMint(): ReturnType<
  typeof vi.fn<(input: Readonly<MintGrantInput>) => ReturnType<OnMint>>
> {
  return vi.fn<(input: Readonly<MintGrantInput>) => ReturnType<OnMint>>(
    async () => Promise.resolve({ ok: true, code: "wm-grant1.x" }),
  );
}

function renderForm(
  delegable: readonly GrantRow[],
  onMint: React.ComponentProps<typeof MintGrantForm>["onMint"],
): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <MintGrantForm delegable={delegable} onMint={onMint} />
    </MantineProvider>,
  );
}

function fillRequiredFields(): void {
  fireEvent.change(screen.getByLabelText(/^Bearer device-id/), {
    target: { value: deviceIdToHex(holder.deviceId) },
  });
  fireEvent.change(screen.getByRole("combobox", { name: /^Capability/ }), {
    target: { value: "room:member" },
  });
  fireEvent.change(screen.getByLabelText(/^Scope kind/), {
    target: { value: "room" },
  });
}

describe("MintGrantForm", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
    // jsdom has no scrollIntoView, which Mantine's option list calls on the highlighted option.
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: vi.fn<() => void>(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  });

  it("refuses to mint when the grant chosen to delegate from is no longer offered, rather than minting a root grant", async () => {
    const row = await heldRow();
    const onMint = vi.fn<
      (
        input: Readonly<MintGrantInput>,
      ) => ReturnType<React.ComponentProps<typeof MintGrantForm>["onMint"]>
    >(async () => Promise.resolve({ ok: true, code: "wm-grant1.x" }));
    const { rerender } = renderForm([row], onMint);
    fillRequiredFields();
    fireEvent.click(screen.getByRole("combobox", { name: /^Delegate from/ }));
    fireEvent.click(
      await screen.findByRole("option", { name: /^room:member from/ }),
    );

    rerender(
      <MantineProvider>
        <MintGrantForm delegable={[]} onMint={onMint} />
      </MantineProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mint grant" }));

    expect(await screen.findByText(/no longer valid/)).toBeInTheDocument();
    expect(onMint).not.toHaveBeenCalled();
  });

  it("mints a root grant when no parent was chosen", async () => {
    const onMint = vi.fn<
      (
        input: Readonly<MintGrantInput>,
      ) => ReturnType<React.ComponentProps<typeof MintGrantForm>["onMint"]>
    >(async () => Promise.resolve({ ok: true, code: "wm-grant1.x" }));
    renderForm([], onMint);
    fillRequiredFields();

    fireEvent.click(screen.getByRole("button", { name: "Mint grant" }));

    await waitFor(() => {
      expect(onMint).toHaveBeenCalledTimes(1);
    });
    expect(onMint.mock.calls[0]?.[0].parent).toBeUndefined();
    expect(await screen.findByText("Grant minted")).toBeInTheDocument();
  });

  it("shows why a mint failed when recording it rejects", async () => {
    renderForm([], async () => Promise.reject(new Error(STORAGE_FAILURE)));
    fillRequiredFields();

    fireEvent.click(screen.getByRole("button", { name: "Mint grant" }));

    expect(await screen.findByText(STORAGE_FAILURE)).toBeInTheDocument();
  });

  it("offers the covered verb and the self-grant bars for a manage:grant, and passes them on", async () => {
    const onMint = recordingMint();
    renderForm([], onMint);
    fillRequiredFields();
    fireEvent.change(screen.getByRole("combobox", { name: /^Capability/ }), {
      target: { value: "manage:grant" },
    });
    fireEvent.change(screen.getByLabelText(/^Covered verb/), {
      target: { value: "exec:pty" },
    });
    fireEvent.change(screen.getByLabelText(/^Barred from granting to itself/), {
      target: { value: "exec:pty, manage:grant" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Mint grant" }));

    await waitFor(() => {
      expect(onMint).toHaveBeenCalledTimes(1);
    });
    expect(onMint.mock.calls[0]?.[0]).toMatchObject({
      targetVerb: "exec:pty",
      selfGrantBars: ["exec:pty", "manage:grant"],
    });
  });

  it("offers neither field for a capability that names no verb", () => {
    renderForm([], recordingMint());
    fillRequiredFields();

    expect(screen.queryByLabelText(/^Covered verb/)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/^Barred from granting to itself/),
    ).not.toBeInTheDocument();
  });

  it("passes a chosen authorising manage:grant to the mint", async () => {
    const authoriser = await heldGrantRow();
    const onMint = recordingMint();
    renderForm([authoriser], onMint);
    fillRequiredFields();
    fireEvent.click(screen.getByRole("combobox", { name: /^Authorised by/ }));
    fireEvent.click(
      await screen.findByRole("option", { name: /^manage:grant from/ }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Mint grant" }));

    await waitFor(() => {
      expect(onMint).toHaveBeenCalledTimes(1);
    });
    expect(onMint.mock.calls[0]?.[0].authorisedBy).toEqual(authoriser.token);
  });

  it("refuses to mint when the authorising grant is no longer offered, rather than dropping its bars", async () => {
    const authoriser = await heldGrantRow();
    const onMint = recordingMint();
    const { rerender } = renderForm([authoriser], onMint);
    fillRequiredFields();
    fireEvent.click(screen.getByRole("combobox", { name: /^Authorised by/ }));
    fireEvent.click(
      await screen.findByRole("option", { name: /^manage:grant from/ }),
    );

    rerender(
      <MantineProvider>
        <MintGrantForm delegable={[]} onMint={onMint} />
      </MantineProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mint grant" }));

    expect(await screen.findByText(/no longer valid/)).toBeInTheDocument();
    expect(onMint).not.toHaveBeenCalled();
  });
});
