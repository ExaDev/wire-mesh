import { describe, expect, it } from "vitest";
import { createTlsTransport } from "../src/adapters/tls-transport.js";
import { deriveDeviceId } from "../src/adapters/node-identity.js";
import { generateCertFixture } from "./tls-cert-fixture.js";
import type { Connection } from "../src/ports/transport.js";

describe("createTlsTransport", () => {
  it("authenticates the peer's device-id on both the dialling and accepting side", async () => {
    const serverIdentity = generateCertFixture();
    const clientIdentity = generateCertFixture();
    const serverTransport = createTlsTransport(serverIdentity);
    const clientTransport = createTlsTransport(clientIdentity);

    let resolveAccepted: (connection: Connection) => void;
    const accepted = new Promise<Connection>((resolve) => {
      resolveAccepted = resolve;
    });
    const listener = await serverTransport.listen(
      "127.0.0.1:0",
      (connection) => {
        resolveAccepted(connection);
      },
    );

    const clientConnection = await clientTransport.connect(listener.address);
    const serverSideConnection = await accepted;

    const expectedServerDeviceId = await deriveDeviceId(
      serverIdentity.rawPublicKey,
    );
    const expectedClientDeviceId = await deriveDeviceId(
      clientIdentity.rawPublicKey,
    );
    // The dialling side authenticates who it dialled...
    expect(clientConnection.peerDeviceId).toEqual(expectedServerDeviceId);
    // ...and the accepting side authenticates who dialled it, independently.
    expect(serverSideConnection.peerDeviceId).toEqual(expectedClientDeviceId);

    await clientConnection.close();
    await listener.close();
  });

  it("leaves peerDeviceId undefined when the accepted connection's peer presents no certificate", async () => {
    const serverIdentity = generateCertFixture();
    const serverTransport = createTlsTransport(serverIdentity);

    let resolveAccepted: (connection: Connection) => void;
    const accepted = new Promise<Connection>((resolve) => {
      resolveAccepted = resolve;
    });
    const listener = await serverTransport.listen(
      "127.0.0.1:0",
      (connection) => {
        resolveAccepted(connection);
      },
    );

    // A bare TLS client with no certificate of its own -- rejectUnauthorized:false on the server means the handshake still completes, but nothing was presented to authenticate against.
    const tls = await import("node:tls");
    const [host, portStr] = listener.address.split(":");
    const socket = tls.connect({
      host,
      port: Number(portStr),
      rejectUnauthorized: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });

    const serverSideConnection = await accepted;
    expect(serverSideConnection.peerDeviceId).toBeUndefined();
    socket.destroy();
    await listener.close();
  });
});
