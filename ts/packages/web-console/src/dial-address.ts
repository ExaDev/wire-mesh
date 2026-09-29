const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i;

const WEBSOCKET_SCHEME_FOR: Readonly<Record<string, string>> = {
  ws: "ws:",
  wss: "wss:",
  http: "ws:",
  https: "wss:",
};

/**
 * The WebSocket URL to dial for an address, whether it came from the connect form or from a gossiped advert.
 *
 * A bare `host:port` keeps its long-standing meaning, plain `ws://`. An address that names its scheme is dialled with it: `ws://` and `wss://` as written, and `http://` and `https://` as the WebSocket scheme a server on that listener speaks. Any fragment is dropped, since a WebSocket URL cannot carry one (the `#sha256=` pin an address may carry is for a transport that verifies it).
 *
 * An address naming any other scheme is returned unchanged, so the transport refuses it through the same failed-connect path as any other address it cannot dial.
 */
export function toWebSocketAddress(address: string): string {
  const match = SCHEME_PATTERN.exec(address);
  if (match === null) {
    return `ws://${address}`;
  }
  const websocketScheme = WEBSOCKET_SCHEME_FOR[match[1]?.toLowerCase() ?? ""];
  if (websocketScheme === undefined) {
    return address;
  }
  const url = new URL(address);
  url.protocol = websocketScheme;
  url.hash = "";
  return url.toString();
}
