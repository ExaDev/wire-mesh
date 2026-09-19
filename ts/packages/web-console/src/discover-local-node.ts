// Same-device node auto-discovery, mirroring agent-comms' own probeLocalMesh shape (mesh-client.ts's isLocal check + a localhost probe) -- but wire-mesh has no port walk-up of its own (a single fixed default, override only via its own --bind flag), so this probes exactly one port rather than climbing a range the way agent-comms' bridge does.

/** wire-mesh's own documented default bind port (ts/packages/node/src/server.ts's DEFAULT_BIND_ADDRESS) -- the one port this module ever probes. */
export const WIRE_MESH_DEFAULT_PORT = 8787;

const LOCAL_HOST_PATTERN = /^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/;

/** True when `host` (as `location.host` reports it) is itself a loopback origin -- matches agent-comms' own isLocal regex in mesh-client.ts exactly, since the same shape of "already local, no discovery needed" applies here too. */
export function isLocalOrigin(host: string): boolean {
  return LOCAL_HOST_PATTERN.test(host);
}

/** Probes wire-mesh's default port on localhost with a plain HTTP fetch (any non-Upgrade request gets a health response -- see server.ts), the same "fetch is simpler and avoids a visible WS error in the console" approach agent-comms' probeLocalMesh uses. Resolves to the node's ws:// address on any response, or undefined if nothing answered. */
export async function probeLocalNode(
  port: number = WIRE_MESH_DEFAULT_PORT,
): Promise<string | undefined> {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/`, { mode: "no-cors" });
    return `ws://127.0.0.1:${String(port)}`;
  } catch {
    return undefined;
  }
}

/** Auto-discovers a same-device wire-mesh node: a no-op (resolves undefined, no network probe) when `host` is already a loopback origin, since a locally-served console already defaults its address field to the same port; otherwise probes localhost for a node to connect to automatically. `host` defaults to the real `location.host` so production call sites need no argument, while tests can pass one directly instead of faking `location`. */
export async function discoverLocalNode(
  host: string = typeof location === "undefined" ? "" : location.host,
): Promise<string | undefined> {
  if (isLocalOrigin(host)) {
    return Promise.resolve(undefined);
  }
  return probeLocalNode();
}
