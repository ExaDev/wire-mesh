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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { UnreadableRevocations } from "../src/components/UnreadableRevocations.js";
import { createRevocationStore } from "../src/revocation-store.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const BAD_KEY = "revocation/x/y";
const CBOR_ZERO = 0;
const clock = { now: () => 0 };

let own: IdentityPort;

beforeAll(async () => {
  own = await createWebCryptoIdentity();
});

beforeEach(() => {
  stubMantineJsdomGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function storeWithBadEntry(): Promise<
  Awaited<ReturnType<typeof createRevocationStore>>
> {
  const storage = createMemoryStorage();
  await storage.set(BAD_KEY, new Uint8Array([CBOR_ZERO]));

  return createRevocationStore({ storage, identity: own, clock });
}

describe("UnreadableRevocations", () => {
  it("shows nothing when every stored revocation loaded", async () => {
    const store = await createRevocationStore({
      storage: createMemoryStorage(),
      identity: own,
      clock,
    });

    render(
      <MantineProvider>
        <UnreadableRevocations
          revocations={store}
          onFailure={() => undefined}
        />
      </MantineProvider>,
    );

    expect(screen.queryByTestId("unreadable-revocations")).toBeNull();
  });

  it("names the entry and why it could not be loaded, warning that a revoked grant may read as valid", async () => {
    const store = await storeWithBadEntry();

    render(
      <MantineProvider>
        <UnreadableRevocations
          revocations={store}
          onFailure={() => undefined}
        />
      </MantineProvider>,
    );

    const warning = screen.getByTestId("unreadable-revocations");
    expect(warning).toHaveTextContent(BAD_KEY);
    expect(warning).toHaveTextContent("it is not a revocation entry");
    expect(warning).toHaveTextContent("may read as valid");
  });

  it("clears once the entry is discarded", async () => {
    const store = await storeWithBadEntry();
    render(
      <MantineProvider>
        <UnreadableRevocations
          revocations={store}
          onFailure={() => undefined}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await vi.waitFor(() => {
      expect(screen.queryByTestId("unreadable-revocations")).toBeNull();
    });
  });

  it("reports a discard that failed, leaving the entry listed", async () => {
    const STORAGE_FAILURE = "the origin's storage quota is exhausted";
    const store = await storeWithBadEntry();
    const onFailure = vi.fn<(message: string) => void>();
    render(
      <MantineProvider>
        <UnreadableRevocations
          revocations={{
            ...store,
            discardUnreadable: async () =>
              Promise.reject(new Error(STORAGE_FAILURE)),
          }}
          onFailure={onFailure}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith(STORAGE_FAILURE);
    });
    expect(screen.getByTestId("unreadable-revocations")).toBeInTheDocument();
  });
});
