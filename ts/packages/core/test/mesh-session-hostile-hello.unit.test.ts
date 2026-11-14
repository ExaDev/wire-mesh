// A hello whose verification fails or throws is dropped: nothing is sent to the peer, and the session keeps serving everyone else. This covers the checking of the hello, not everything a hello could provoke. A key the identity port reports as unusable is a verdict about the peer; any other failure of the port is local, reported to the owner and not to the peer.

import { describe, expect, it, vi } from "vitest";
import { messageFromFrame } from "../src/adapters/frame-codec.js";
import {
  createMeshSession,
  type IncomingManageRequest,
} from "../src/domain/mesh-session.js";
import { beginHandshake } from "../src/domain/secure-channel.js";
import type {
  CapabilityScope,
  Frame,
  ManageCommand,
  SecureHelloFrame,
} from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import {
  deviceA,
  fakeTransport,
  identityA,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";
import { RelayPeer } from "./relay-peer.js";

const command: ManageCommand = {
  verb: "exec:proc",
  params: { verb: "exec.list" },
};
const scope: CapabilityScope = { kind: "folder" };
const REQUEST_ID = 77;
const SETTLE_MS = 30;
const UNSUPPORTED_ALG = -999;
const ES256 = -7;
const P256_POINT_BYTES = 65;
const SEC1_UNCOMPRESSED = 4;
const WRONG_SIZE_KEY_BYTES = 3;

async function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

function offCurveP256(): Uint8Array<ArrayBuffer> {
  const point = new Uint8Array(P256_POINT_BYTES).fill(1);
  point[0] = SEC1_UNCOMPRESSED;

  return point;
}

async function sessionWith(
  identity: IdentityPort,
  onFault: (fault: unknown) => void,
): Promise<{
  session: ReturnType<typeof createMeshSession>;
  connection: ReturnType<typeof fakeTransport>["connection"];
  incoming: IncomingManageRequest[];
  states: string[];
}> {
  const { transport, connection } = fakeTransport();
  const session = createMeshSession(
    transport,
    identity,
    testClock,
    null,
    [],
    undefined,
    undefined,
    onFault,
  );
  await session.connect("ws://node", ["core/management"]);
  const incoming: IncomingManageRequest[] = [];
  const states: string[] = [];
  void (async (): Promise<void> => {
    for await (const request of session.incomingManageRequests) {
      incoming.push(request);
    }
  })();
  void (async (): Promise<void> => {
    for await (const event of session.events) {
      states.push(event.state.status);
    }
  })();

  return { session, connection, incoming, states };
}

async function helloTo(identity: IdentityPort): Promise<SecureHelloFrame> {
  return (await beginHandshake(identityA, identity.deviceId)).hello;
}

function pushHello(
  connection: ReturnType<typeof fakeTransport>["connection"],
  hello: SecureHelloFrame,
): void {
  connection.push({
    type: "relay-data",
    payload: messageFromFrame(hello),
    "from-device": deviceA,
  });
}

function sentHellos(
  connection: ReturnType<typeof fakeTransport>["connection"],
): Frame[] {
  return connection.sent.filter((frame) => {
    if (frame.type !== "relay-data") return false;
    const inner = new TextDecoder("latin1").decode(frame.payload);

    return inner.includes("secure-hello");
  });
}

describe("a hostile hello", () => {
  const hostile: readonly (readonly [
    string,
    (hello: SecureHelloFrame) => SecureHelloFrame,
  ])[] = [
    [
      "an unsupported identity-key algorithm",
      (hello) => ({
        ...hello,
        "identity-key": { ...hello["identity-key"], alg: UNSUPPORTED_ALG },
      }),
    ],
    [
      "an ES256 key that is not a point on the curve",
      (hello) => ({
        ...hello,
        "identity-key": { alg: ES256, "public-key": offCurveP256() },
      }),
    ],
    [
      "a key of the wrong size",
      (hello) => ({
        ...hello,
        "identity-key": {
          ...hello["identity-key"],
          "public-key": new Uint8Array(WRONG_SIZE_KEY_BYTES),
        },
      }),
    ],
    [
      "a signature that does not verify",
      (hello) => ({
        ...hello,
        signature: new Uint8Array(hello.signature.length),
      }),
    ],
  ];

  for (const [name, corrupt] of hostile) {
    it(`with ${name} is dropped: no reply, the session stays up and serves the next peer`, async () => {
      const faults: unknown[] = [];
      const { session, connection, incoming, states } = await sessionWith(
        testIdentity,
        (fault) => {
          faults.push(fault);
        },
      );

      pushHello(connection, corrupt(await helloTo(testIdentity)));
      await settle();
      expect(sentHellos(connection)).toEqual([]);

      const peer = new RelayPeer(identityA, testIdentity, connection);
      await peer.openTowardSession();
      await peer.deliver({
        type: "manage-request",
        "request-id": REQUEST_ID,
        command,
        scope,
      });
      await vi.waitFor(() => {
        expect(incoming.map((request) => request.requestId)).toEqual([
          REQUEST_ID,
        ]);
      });
      expect(states).not.toContain("reconnecting");
      expect(states).not.toContain("closed");
      // The identity port said the key was unusable: that is a verdict, not a local fault.
      expect(faults).toEqual([]);
      await session.close();
    });
  }

  it("is dropped, and the failure reported locally and not to the peer, when the identity port itself fails", async () => {
    const failing: IdentityPort = {
      ...testIdentity,
      verify: async () =>
        Promise.reject(new TypeError("the hardware key went away")),
    };
    const faults: unknown[] = [];
    const { session, connection, states } = await sessionWith(
      failing,
      (fault) => {
        faults.push(fault);
      },
    );

    pushHello(connection, await helloTo(failing));
    await settle();

    expect(faults).toHaveLength(1);
    expect(faults[0]).toBeInstanceOf(TypeError);
    expect(sentHellos(connection)).toEqual([]);
    expect(states).not.toContain("reconnecting");
    expect(states).not.toContain("closed");
    await session.close();
  });

  it("is dropped, and the failure reported locally, when hashing its key fails", async () => {
    const failing: IdentityPort = {
      ...testIdentity,
      deriveDeviceId: async () => Promise.reject(new Error("no digest")),
    };
    const faults: unknown[] = [];
    const { session, connection, states } = await sessionWith(
      failing,
      (fault) => {
        faults.push(fault);
      },
    );

    pushHello(connection, await helloTo(failing));
    await settle();

    expect(faults).toHaveLength(1);
    expect(sentHellos(connection)).toEqual([]);
    expect(states).not.toContain("closed");
    await session.close();
  });

  it("does not need anyone to listen for local faults", async () => {
    const failing: IdentityPort = {
      ...testIdentity,
      verify: async () => Promise.reject(new Error("failing")),
    };
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, failing, testClock);
    await session.connect("ws://node", ["core/management"]);

    pushHello(connection, await helloTo(failing));
    await settle();

    expect(sentHellos(connection)).toEqual([]);
    await session.close();
  });
});
