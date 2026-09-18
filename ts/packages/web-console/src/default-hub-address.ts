// Derives the console's default Node address from the page's own origin, so a build served from the same origin as a hub (mesh.exadev.io, or any other colocated deployment per ExaDev/wire-mesh#183) points at that hub without the operator typing anything. Vite's dev server and the hub's own wrangler dev port are two different processes on two different ports though, so this only applies to a production build; dev keeps the hardcoded local hub port the README's own local-workflow instructions already document.

export const LOCAL_DEV_HUB_ADDRESS = "ws://localhost:8787";

export function sameOriginHubAddress(
  location: Readonly<Pick<Location, "protocol" | "host">>,
): string {
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${location.host}`;
}

export function defaultHubAddress(
  isDev: boolean,
  location: Readonly<Pick<Location, "protocol" | "host">>,
): string {
  return isDev ? LOCAL_DEV_HUB_ADDRESS : sameOriginHubAddress(location);
}
