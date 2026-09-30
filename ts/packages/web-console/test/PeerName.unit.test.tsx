// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DirectoryEntry } from "wire-mesh-core/domain/mesh-session";
import type { NameStore } from "../src/name-store.js";
import { PeerName } from "../src/components/PeerName.js";
import { usePeerNames } from "../src/hooks/use-peer-names.js";
import { selfNameExtension, shortId } from "../src/peer-names.js";
import { deviceIdFromFillHex } from "./hex.js";
import { WithNames, memoryNameStore } from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { syntheticAdvertProof } from "./synthetic-advert.js";

const DEVICE_ID_HEX_LENGTH = 64;
const FIRST_FILL = "ab";
const SECOND_FILL = "cd";
const FIRST_HEX = FIRST_FILL.repeat(DEVICE_ID_HEX_LENGTH / FIRST_FILL.length);
const SECOND_HEX = SECOND_FILL.repeat(
  DEVICE_ID_HEX_LENGTH / SECOND_FILL.length,
);
const CLAIMED_NAME = "Alice";

function entry(
  fill: string,
  extension: Record<string, unknown>,
): DirectoryEntry {
  return {
    device: deviceIdFromFillHex(fill),
    advert: {
      device: deviceIdFromFillHex(fill),
      addresses: [],
      "snapshot-seconds": 0,
      ...syntheticAdvertProof(),
      ...extension,
    },
  };
}

/** Feeds a directory to the naming context the way a connection panel does, and renders each given device's PeerName. */
function Observed({
  directory,
  devices,
}: Readonly<{
  directory: readonly DirectoryEntry[];
  devices: readonly string[];
}>): React.JSX.Element {
  const { observeDirectory } = usePeerNames();
  useEffect(() => {
    observeDirectory(directory);
  }, [directory, observeDirectory]);
  return (
    <ul>
      {devices.map((hex) => (
        <li key={hex} data-testid={hex}>
          <PeerName deviceHex={hex} />
        </li>
      ))}
    </ul>
  );
}

function renderObserved(
  directory: readonly DirectoryEntry[],
  store: Readonly<NameStore> = memoryNameStore(),
): ReturnType<typeof render> {
  return render(
    <WithNames store={store}>
      <Observed directory={directory} devices={[FIRST_HEX, SECOND_HEX]} />
    </WithNames>,
  );
}

describe("PeerName", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("tells two peers claiming the same name apart by their short ids", async () => {
    renderObserved([
      entry(FIRST_FILL, selfNameExtension(CLAIMED_NAME)),
      entry(SECOND_FILL, selfNameExtension(CLAIMED_NAME)),
    ]);

    await vi.waitFor(() => {
      expect(screen.getByTestId(FIRST_HEX)).toHaveTextContent(
        `${CLAIMED_NAME} (${shortId(FIRST_HEX)})`,
      );
    });
    expect(screen.getByTestId(SECOND_HEX)).toHaveTextContent(
      `${CLAIMED_NAME} (${shortId(SECOND_HEX)})`,
    );
  });

  it("shows a petname alone, since the viewer chose it", async () => {
    const store = memoryNameStore();
    await store.setPetname(FIRST_HEX, "Ada");
    renderObserved([entry(FIRST_FILL, selfNameExtension(CLAIMED_NAME))], store);

    await vi.waitFor(() => {
      expect(screen.getByTestId(FIRST_HEX)).toHaveTextContent(/^Ada$/);
    });
  });

  it("drops a name once a later advert from the peer no longer asserts one", async () => {
    const { rerender } = renderObserved([
      entry(FIRST_FILL, selfNameExtension(CLAIMED_NAME)),
    ]);
    await vi.waitFor(() => {
      expect(screen.getByTestId(FIRST_HEX)).toHaveTextContent(CLAIMED_NAME);
    });

    rerender(
      <WithNames>
        <Observed
          directory={[entry(FIRST_FILL, {})]}
          devices={[FIRST_HEX, SECOND_HEX]}
        />
      </WithNames>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId(FIRST_HEX)).toHaveTextContent(
        new RegExp(`^${shortId(FIRST_HEX)}$`),
      );
    });
  });
});
