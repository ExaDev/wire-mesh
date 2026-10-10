// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ConnectionHealth } from "../src/components/ConnectionHealth.js";
import { reconnectPolicy } from "../src/reconnect-policy.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const MS_PER_SECOND = 1000;
const THIRD_ATTEMPT = 3;
const FIFTH_ATTEMPT = 5;
/** The backoff delay of attempt n is the base delay doubled n - 1 times, so these are the seconds the shared policy gives. */
const FIRST_DELAY_S = 1;
const THIRD_DELAY_S = 4;
const FIFTH_DELAY_S = 16;

function renderReconnecting(attempt: number, now: number): HTMLElement {
  render(
    <MantineProvider>
      <ConnectionHealth
        state={{
          status: "reconnecting",
          address: "ws://hub.example:8787",
          attempt,
          reason: "socket closed",
        }}
        statusSince={0}
        now={now}
        policy={reconnectPolicy}
        health={{
          samples: [],
          unresponsive: false,
          probe: vi.fn<() => void>(),
        }}
      />
    </MantineProvider>,
  );

  return screen.getByTestId("reconnect-status");
}

describe("ConnectionHealth reconnect countdown", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    [1, FIRST_DELAY_S],
    [THIRD_ATTEMPT, THIRD_DELAY_S],
    [FIFTH_ATTEMPT, FIFTH_DELAY_S],
  ])(
    "counts down the backoff delay of attempt %i from when the connection dropped",
    (attempt, delayS) => {
      expect(renderReconnecting(attempt, 0)).toHaveTextContent(
        `Retrying in ${String(delayS)} s (attempt ${String(attempt)} of ${String(reconnectPolicy.maxAttempts)})`,
      );
    },
  );

  it("subtracts the time already waited from the attempt's delay", () => {
    expect(renderReconnecting(THIRD_ATTEMPT, MS_PER_SECOND)).toHaveTextContent(
      `Retrying in ${String(THIRD_DELAY_S - 1)} s`,
    );
  });

  it("says the attempt is due once its delay has passed", () => {
    expect(
      renderReconnecting(THIRD_ATTEMPT, THIRD_DELAY_S * MS_PER_SECOND),
    ).toHaveTextContent("Retrying now");
  });
});
