// The layout Mantine's own style props don't cover cleanly: capping the console's own content width and centring it on a wide viewport, so the peer tables don't stretch edge-to-edge on a desktop monitor, and turning a peer table into a stack of labelled cards on a phone.

import { globalStyle, style } from "@vanilla-extract/css";

export const appShell = style({
  maxWidth: "64rem",
  marginInline: "auto",
  // A long address or device-id with no break opportunity would otherwise widen the page past a phone's viewport.
  overflowWrap: "anywhere",
});

/** Mantine's `xs` breakpoint (the same 36em vite.config.ts hands the PostCSS pipeline), below which a peer table no longer fits a row of columns. */
const PHONE_MEDIA = "screen and (max-width: 36em)";

/** A table whose rows become cards on a phone: the header row is hidden and each cell shows its column's name (its `data-label`) above its value. */
export const stackedTable = style({});

globalStyle(`${stackedTable} thead`, {
  "@media": {
    [PHONE_MEDIA]: {
      position: "absolute",
      width: 1,
      height: 1,
      overflow: "hidden",
      clip: "rect(0 0 0 0)",
    },
  },
});

globalStyle(`${stackedTable} tr`, {
  "@media": {
    [PHONE_MEDIA]: {
      display: "block",
      paddingBlock: "0.5rem",
    },
  },
});

globalStyle(`${stackedTable} td`, {
  "@media": {
    [PHONE_MEDIA]: {
      display: "block",
      border: "none",
      paddingBlock: "0.125rem",
    },
  },
});

globalStyle(`${stackedTable} td::before`, {
  "@media": {
    [PHONE_MEDIA]: {
      content: "attr(data-label)",
      display: "block",
      fontSize: "0.75rem",
      opacity: 0.7,
    },
  },
});
