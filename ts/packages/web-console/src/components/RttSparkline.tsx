// A small line of recent round-trip times, drawn as inline SVG so it follows the colour scheme through `currentColor`. Every measured sample also gets a dot, because a line needs two points and the first probe alone would otherwise draw nothing. A probe that got no pong is a red tick on the baseline, so a gap in service reads differently from a slow link.

import { Text } from "@mantine/core";
import type { RttSample } from "../hooks/use-connection-health.js";
import { MAX_SAMPLES } from "../hooks/use-connection-health.js";

const WIDTH = 160;
const HEIGHT = 32;
const PADDING = 3;
/** The radius of the dot marking a measured sample. */
const DOT_RADIUS = 2;
/** How tall the tick marking a lost probe is. */
const TICK_HEIGHT = 8;
const PLOT_HEIGHT = HEIGHT - PADDING * 2;

export interface RttSparklineProps {
  samples: readonly RttSample[];
}

function describe(samples: readonly RttSample[]): string {
  const last = samples.at(-1);
  if (last === undefined) {
    return samples.length === 0
      ? "No round trips measured yet"
      : "Last ping got no pong";
  }
  return `Round trip ${String(Math.round(last))} ms`;
}

export function RttSparkline({
  samples,
}: Readonly<RttSparklineProps>): React.JSX.Element {
  const measured = samples.filter((sample) => sample !== undefined);
  const slowest = Math.max(1, ...measured);
  const step = WIDTH / (MAX_SAMPLES - 1);
  // Samples fill the width from the right, so a new one slides in rather than the whole line rescaling.
  const offset = (MAX_SAMPLES - samples.length) * step;
  const points = samples.map((sample, index) => ({
    x: offset + index * step,
    y:
      sample === undefined
        ? undefined
        : PADDING + PLOT_HEIGHT * (1 - sample / slowest),
  }));
  const line = points
    .filter((point) => point.y !== undefined)
    .map((point) => `${point.x.toFixed(1)},${String(point.y)}`)
    .join(" ");
  return (
    <div data-testid="rtt-sparkline">
      <svg
        role="img"
        aria-label={describe(samples)}
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      >
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        />
        {points.map((point) =>
          point.y === undefined ? null : (
            <circle
              key={point.x}
              cx={point.x}
              cy={point.y}
              r={DOT_RADIUS}
              fill="currentColor"
            />
          ),
        )}
        {points
          .filter((point) => point.y === undefined)
          .map((point) => (
            <line
              key={point.x}
              x1={point.x}
              x2={point.x}
              y1={HEIGHT - PADDING - TICK_HEIGHT}
              y2={HEIGHT - PADDING}
              stroke="var(--mantine-color-red-6)"
              strokeWidth={2}
            />
          ))}
      </svg>
      <Text size="xs" c="dimmed">
        {describe(samples)}
      </Text>
    </div>
  );
}
