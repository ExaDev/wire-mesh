import { isPinnedAddress } from "wire-mesh-core/domain/pinned-address";
import type { Transport } from "wire-mesh-core/ports/transport";
import type { CertificateMemory } from "../certificate-memory.js";
import { createBrowserWebTransportTransport } from "./webtransport-transport.js";
import { createBrowserTransport } from "./websocket-transport.js";

/**
 * The Transport the console dials every node with: an address that carries a certificate pin goes over WebTransport, any other over WebSocket. The choice is made from the address alone, so a session that reconnects or expands through gossip picks the right one for each address it learns.
 */
export function createDialTransport(
  memory: Readonly<CertificateMemory>,
): Transport {
  const webSocket = createBrowserTransport();
  const webTransport = createBrowserWebTransportTransport(memory);

  return {
    connect: async (address) =>
      isPinnedAddress(address)
        ? webTransport.connect(address)
        : webSocket.connect(address),
    listen: async (address, onConnection) =>
      webSocket.listen(address, onConnection),
  };
}
