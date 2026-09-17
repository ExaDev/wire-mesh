import { encode, cdeEncodeOptions } from "cbor2";
import { describe, expect, it } from "vitest";
import { createTcpTransport } from "../src/adapters/tcp-transport.js";
import type { Connection } from "../src/ports/transport.js";
import type { ManageRequestFrame } from "../src/generated/protocol.js";

const BYTE_MODULUS = 256;
const PROTECTED_HEADER_LENGTH = 8;
const PAYLOAD_LENGTH = 64;
const SIGNATURE_LENGTH = 4;
const PROTECTED_HEADER_SEED = 11;
const PAYLOAD_SEED = 7;
const SIGNATURE_SEED = 13;

/** Deterministic, distinguishable filler bytes -- the actual values are irrelevant to what this test checks, only that a genuine multi-byte, non-uniform byte string round-trips through a real socket unchanged. Uint8Array.from()'s own return type is the wider Uint8Array<ArrayBufferLike>; a fresh Uint8Array copy narrows it to the concrete Uint8Array<ArrayBuffer> the generated schemas' tuple fields require. */
function fillerBytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    Uint8Array.from(
      Array.from({ length }, (_unused, index) => (index * seed) % BYTE_MODULUS),
    ),
  );
}

/**
 * Regression test for a real bug: cbor2's decode() mirrors the class of the buffer it's given for nested
 * byte-string values (a Node Buffer input yields Buffer-typed byte strings, not plain Uint8Array), and its
 * own encode() then fails to recognise a Buffer as a byte string at all -- silently mis-encoding it as a
 * generic object instead. A capability token's own signature verification re-encodes its protected-header
 * and payload byte strings (COSE's Sig_structure) to check the signature, so a token received over this raw
 * Buffer-backed socket previously failed that re-encode round trip -- and therefore failed signature
 * verification -- despite the token's bytes themselves crossing the wire perfectly intact. This test proves
 * the wire path itself (not any one domain's use of it) by re-encoding a received byte string exactly the
 * way Sig_structure reconstruction does, and checking it reproduces the pre-send bytes.
 */
describe("createTcpTransport byte-string re-encoding", () => {
  it("hands received nested byte strings back out as re-encodable, not Buffer-corrupted", async () => {
    const serverTransport = createTcpTransport();
    const clientTransport = createTcpTransport();

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
    const serverConnection = await accepted;

    const protectedHeader = fillerBytes(
      PROTECTED_HEADER_LENGTH,
      PROTECTED_HEADER_SEED,
    );
    const payload = fillerBytes(PAYLOAD_LENGTH, PAYLOAD_SEED);
    const signature = fillerBytes(SIGNATURE_LENGTH, SIGNATURE_SEED);

    const REQUEST_ID = 1;
    const frame: ManageRequestFrame = {
      type: "manage-request",
      "request-id": REQUEST_ID,
      command: { verb: "room:member", params: { verb: "room.join" } },
      scope: { kind: "room", path: "test" },
      token: [protectedHeader, {}, payload, signature],
    };

    const receivedFramePromise = (async () => {
      for await (const oneFrame of serverConnection.receive()) {
        return oneFrame;
      }
      throw new Error("connection closed before a frame arrived");
    })();

    await clientConnection.send(frame);
    const receivedFrame = await receivedFramePromise;
    if (
      receivedFrame.type !== "manage-request" ||
      receivedFrame.token === undefined
    ) {
      throw new Error("expected a manage-request frame carrying a token");
    }
    const [receivedProtectedHeader, , receivedPayload] = receivedFrame.token;

    // The actual defect: re-encoding a received byte string the way COSE's Sig1-to-be-signed
    // reconstruction does must reproduce exactly what encoding the original, pre-send byte string
    // produces -- a Buffer-corrupted decode instead serializes it as an object, so this comparison
    // is where the bug actually manifested.
    const originalEncoded = encode(
      ["Signature1", protectedHeader, new Uint8Array(0), payload],
      cdeEncodeOptions,
    );
    const receivedEncoded = encode(
      [
        "Signature1",
        receivedProtectedHeader,
        new Uint8Array(0),
        receivedPayload,
      ],
      cdeEncodeOptions,
    );
    expect(
      Buffer.from(receivedEncoded).equals(Buffer.from(originalEncoded)),
    ).toBe(true);

    await clientConnection.close();
    await listener.close();
  });
});
