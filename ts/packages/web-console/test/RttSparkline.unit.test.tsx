// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { RttSparkline } from "../src/components/RttSparkline.js";
import type { RttSample } from "../src/hooks/use-connection-health.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const FAST_RTT_MS = 10;
const SLOW_RTT_MS = 20;
const LAST_RTT_MS = 15;
const SAMPLE_COUNT = 3;

function renderSparkline(samples: readonly RttSample[]): HTMLElement {
  render(
    <MantineProvider>
      <RttSparkline samples={samples} />
    </MantineProvider>,
  );

  return screen.getByTestId("rtt-sparkline");
}

describe("RttSparkline", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says nothing has been measured before the first sample", () => {
    renderSparkline([]);

    expect(screen.getByRole("img")).toHaveAccessibleName(
      "No round trips measured yet",
    );
  });

  it("names the latest round trip and draws one point per measured sample", () => {
    const chart = renderSparkline([FAST_RTT_MS, SLOW_RTT_MS, LAST_RTT_MS]);

    expect(screen.getByRole("img")).toHaveAccessibleName(
      `Round trip ${String(LAST_RTT_MS)} ms`,
    );
    const points = chart.querySelector("polyline")?.getAttribute("points");
    expect(points?.split(" ")).toHaveLength(SAMPLE_COUNT);
    expect(chart.querySelectorAll("circle")).toHaveLength(SAMPLE_COUNT);
  });

  it("draws a dot for a lone first sample, which is too few points for a line", () => {
    const chart = renderSparkline([FAST_RTT_MS]);

    expect(chart.querySelectorAll("circle")).toHaveLength(1);
  });

  it("marks a probe with no pong as a tick, apart from the line", () => {
    const chart = renderSparkline([FAST_RTT_MS, undefined]);

    expect(screen.getByRole("img")).toHaveAccessibleName(
      "Last ping got no pong",
    );
    expect(chart.querySelectorAll("line")).toHaveLength(1);
    expect(chart.querySelectorAll("circle")).toHaveLength(1);
    const points = chart.querySelector("polyline")?.getAttribute("points");
    expect(points?.split(" ")).toHaveLength(1);
  });
});
