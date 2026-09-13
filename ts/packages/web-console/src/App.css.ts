// The one piece of layout Mantine's own style props don't cover cleanly: capping the console's own content width and centring it on a wide viewport, so the peer directory and frame log tables don't stretch edge-to-edge on a desktop monitor.

import { style } from "@vanilla-extract/css";

export const appShell = style({
  maxWidth: "64rem",
  marginInline: "auto",
});
