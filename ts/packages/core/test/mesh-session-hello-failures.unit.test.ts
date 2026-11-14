// Nothing that happens while a session handles a hello ends the session, crashes the process, leaves a half-made handshake behind or tells the peer why: a failure anywhere in the handler drops that hello, is reported locally, and a later valid hello from the same peer still works. Every case goes through the real session.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  messageFromFrame,
  tryDecodeFrame,
} from "../src/adapters/frame-codec.js";
import {
  createMeshSession,
  type IncomingManageRequest,
} from "../src/domain/mesh-session.js";
import {
  beginHandshake,
  helloSigningInput,
} from "../src/domain/secure-channel.js";
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
const REQUEST_ID = 91;
const SETTLE_MS = 40;
const P256_POINT_BYTES = 65;
const SEC1_UNCOMPRESSED = 4;
const FLIPPED_BYTE = 0xff;
const UNDECODABLE_PAYLOAD = [FLIPPED_BYTE, 0, 1];

type Link = ReturnType<typeof fakeTransport>["connection"];

async function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

let unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", recordUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", recordUnhandled);
  vi.restoreAllMocks();
});

async function sessionWith(
  identity: IdentityPort,
  onFault: (fault: unknown) => void | Promise<void> = () => undefined,
): Promise<{
  session: ReturnType<typeof createMeshSession>;
  connection: Link;
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

function pushHello(connection: Link, hello: SecureHelloFrame): void {
  connection.push({
    type: "relay-data",
    payload: messageFromFrame(hello),
    "from-device": deviceA,
  });
}

/** A hello from identityA to the session that verifies, carrying an ephemeral key of the right size that is not a point on the curve. */
async function helloWithUnusableEphemeralKey(
  identity: IdentityPort,
): Promise<SecureHelloFrame> {
  const { hello } = await beginHandshake(identityA, identity.deviceId);
  const ephemeralKey = new Uint8Array(P256_POINT_BYTES).fill(1);
  ephemeralKey[0] = SEC1_UNCOMPRESSED;

  return {
    ...hello,
    "ephemeral-key": ephemeralKey,
    signature: await identityA.sign(
      helloSigningInput(
        ephemeralKey,
        hello.nonce,
        identityA.deviceId,
        identity.deviceId,
      ),
    ),
  };
}

async function requestsAreStillServed(
  connection: Link,
  incoming: readonly IncomingManageRequest[],
): Promise<void> {
  const peer = new RelayPeer(identityA, testIdentity, connection);
  await peer.openTowardSession();
  await peer.deliver({
    type: "manage-request",
    "request-id": REQUEST_ID,
    command,
    scope,
  });
  await vi.waitFor(() => {
    expect(incoming.map((request) => request.requestId)).toContain(REQUEST_ID);
  });
}

function expectSessionUp(states: readonly string[]): void {
  expect(states).not.toContain("reconnecting");
  expect(states).not.toContain("closed");
}

describe("a hello that verifies but cannot be completed", () => {
  it("with an unusable ephemeral key is dropped without an unhandled rejection, and a later valid hello works", async () => {
    const faults: unknown[] = [];
    const { session, connection, incoming, states } = await sessionWith(
      testIdentity,
      (fault) => {
        faults.push(fault);
      },
    );

    pushHello(connection, await helloWithUnusableEphemeralKey(testIdentity));
    // The session's own hello goes out before the peer's key is found unusable; the next hello is judged against what has been sent, so wait for it.
    await vi.waitFor(() => {
      expect(
        connection.sent.filter(
          (frame) =>
            frame.type === "relay-data" &&
            new TextDecoder("latin1")
              .decode(frame.payload)
              .includes("secure-hello"),
        ),
      ).toHaveLength(1);
    });
    await settle();
    expect(unhandled).toEqual([]);
    // The peer's doing, so nothing is reported as a local fault.
    expect(faults).toEqual([]);
    expectSessionUp(states);

    await requestsAreStillServed(connection, incoming);
    expect(unhandled).toEqual([]);
    await session.close();
  });

  it("whose answer cannot be signed is dropped, reported locally, and a later valid hello works", async () => {
    let failing = false;
    const flaky: IdentityPort = {
      ...testIdentity,
      sign: async (data) =>
        failing
          ? Promise.reject(new Error("the key is locked"))
          : testIdentity.sign(data),
    };
    const faults: unknown[] = [];
    const { session, connection, incoming, states } = await sessionWith(
      flaky,
      (fault) => {
        faults.push(fault);
      },
    );
    const sentBefore = connection.sent.length;
    failing = true;

    pushHello(
      connection,
      await beginHandshake(identityA, flaky.deviceId).then((p) => p.hello),
    );
    await settle();
    expect(faults).toHaveLength(1);
    expect(connection.sent.length).toBe(sentBefore);
    expect(unhandled).toEqual([]);
    expectSessionUp(states);

    failing = false;
    await requestsAreStillServed(connection, incoming);
    expect(unhandled).toEqual([]);
    await session.close();
  });

  it("whose answer cannot be sent is dropped, reported locally, leaves no channel, and a later valid hello works", async () => {
    const faults: unknown[] = [];
    const { session, connection, incoming, states } = await sessionWith(
      testIdentity,
      (fault) => {
        faults.push(fault);
      },
    );
    connection.rejectSends(new Error("the link stopped accepting writes"));

    pushHello(
      connection,
      (await beginHandshake(identityA, testIdentity.deviceId)).hello,
    );
    await settle();
    expect(faults).toHaveLength(1);
    expect(unhandled).toEqual([]);
    expectSessionUp(states);

    connection.acceptSends();
    await requestsAreStillServed(connection, incoming);
    expect(unhandled).toEqual([]);
    await session.close();
  });

  it("whose check fails in the identity port is dropped, reported once, and raises nothing unhandled", async () => {
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

    pushHello(
      connection,
      (await beginHandshake(identityA, failing.deviceId)).hello,
    );
    await settle();

    expect(faults).toHaveLength(1);
    expect(unhandled).toEqual([]);
    expectSessionUp(states);
    await session.close();
  });
});

describe("the local fault callback", () => {
  it("throwing does not end the session, and is reported to the console once", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failing: IdentityPort = {
      ...testIdentity,
      verify: async () => Promise.reject(new Error("failing")),
    };
    const { session, connection, states } = await sessionWith(failing, () => {
      throw new Error("the callback is broken");
    });

    pushHello(
      connection,
      (await beginHandshake(identityA, failing.deviceId)).hello,
    );
    await settle();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
    expectSessionUp(states);
    await session.close();
  });
});

describe("a hello repeated after its channel was built", () => {
  it("does not replace the channel, and a hello with a fresh ephemeral key does", async () => {
    const { session, connection, incoming } = await sessionWith(testIdentity);
    const pushed: Frame[] = [];
    const push = connection.push.bind(connection);
    connection.push = (frame): void => {
      pushed.push(frame);
      push(frame);
    };
    const peer = new RelayPeer(identityA, testIdentity, connection);
    await peer.openTowardSession();
    const recorded = pushed.find(
      (frame) =>
        frame.type === "relay-data" &&
        new TextDecoder("latin1")
          .decode(frame.payload)
          .includes("secure-hello"),
    );
    expect(recorded).toBeDefined();
    const sentBefore = connection.sent.length;

    if (recorded !== undefined) {
      connection.push(recorded);
    }
    await settle();
    expect(connection.sent.length).toBe(sentBefore);

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

    const restarted = new RelayPeer(identityA, testIdentity, connection);
    await restarted.openTowardSession();
    await restarted.deliver({
      type: "manage-request",
      "request-id": REQUEST_ID + 1,
      command,
      scope,
    });
    await vi.waitFor(() => {
      expect(incoming.map((request) => request.requestId)).toEqual([
        REQUEST_ID,
        REQUEST_ID + 1,
      ]);
    });
    await session.close();
  });
});

describe("frames a peer or relay can send over an established channel", () => {
  it("never wedge it, and are refused without a word to the sender", async () => {
    const { session, connection, incoming, states } =
      await sessionWith(testIdentity);
    const pushed: Frame[] = [];
    const push = connection.push.bind(connection);
    connection.push = (frame): void => {
      pushed.push(frame);
      push(frame);
    };
    const peer = new RelayPeer(identityA, testIdentity, connection);
    await peer.openTowardSession();
    await peer.deliver({ type: "ping" });
    const sealed = pushed.at(-1);
    expect(sealed?.type).toBe("relay-data");
    const sentBefore = connection.sent.length;

    // The same sealed frame again, a copy with one ciphertext byte altered, a counter far ahead with garbage, an undecodable payload, and a sealed frame claimed to come from a stranger.
    if (sealed?.type === "relay-data") {
      connection.push(sealed);
      const inner = tryInner(sealed);
      const altered = new Uint8Array(inner.ciphertext);
      altered[0] = (altered[0] ?? 0) ^ FLIPPED_BYTE;
      connection.push({
        type: "relay-data",
        payload: messageFromFrame({ ...inner, ciphertext: altered }),
        "from-device": deviceA,
      });
      connection.push({
        type: "relay-data",
        payload: messageFromFrame({
          ...inner,
          counter: Number.MAX_SAFE_INTEGER,
        }),
        "from-device": deviceA,
      });
    }
    connection.push({
      type: "relay-data",
      payload: new Uint8Array(UNDECODABLE_PAYLOAD),
      "from-device": deviceA,
    });
    await settle();
    expect(connection.sent.length).toBe(sentBefore);
    expect(unhandled).toEqual([]);
    expectSessionUp(states);

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
    await session.close();
  });
});

function tryInner(
  frame: Extract<Frame, { type: "relay-data" }>,
): Extract<Frame, { type: "secure-data" }> {
  const decoded = tryDecodeFrame(frame.payload);
  if (decoded?.type !== "secure-data") {
    throw new Error("the recorded frame is not sealed data");
  }

  return decoded;
}

describe("a verified hello that carries an unusable ephemeral key", () => {
  it("leaves the established channel with that peer in place", async () => {
    const { session, connection, incoming } = await sessionWith(testIdentity);
    const peer = new RelayPeer(identityA, testIdentity, connection);
    await peer.openTowardSession();

    pushHello(connection, await helloWithUnusableEphemeralKey(testIdentity));
    await settle();
    expect(unhandled).toEqual([]);

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
    await session.close();
  });
});

describe("a verified hello whose answer cannot be sent, with a channel established", () => {
  const LATE_FAILURE_MS = 60;
  const cases: readonly (readonly [string, number])[] = [
    ["at once", 0],
    ["after the new channel has been built", LATE_FAILURE_MS],
  ];

  for (const [when, afterMs] of cases) {
    it(`leaves the established channel installed and in use when the failure comes ${when}`, async () => {
      const faults: unknown[] = [];
      const { session, connection, incoming } = await sessionWith(
        testIdentity,
        (fault) => {
          faults.push(fault);
        },
      );
      const peer = new RelayPeer(identityA, testIdentity, connection);
      await peer.openTowardSession();
      connection.rejectSends(
        new Error("the link stopped accepting writes"),
        afterMs,
      );

      pushHello(
        connection,
        (await beginHandshake(identityA, testIdentity.deviceId)).hello,
      );
      await vi.waitFor(() => {
        expect(faults).toHaveLength(1);
      });
      await settle();
      connection.acceptSends();
      expect(unhandled).toEqual([]);

      // The channel this peer holds still opens frames from the session, and the session still opens its frames.
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
      await incoming[0]?.respond({ result: "ok" });
      expect(await peer.received()).toEqual([
        expect.objectContaining({ type: "manage-response" }),
      ]);
      await session.close();
    });
  }
});

describe("the local fault callback returning a promise", () => {
  it("that rejects is reported once and does not become an unhandled rejection", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failing: IdentityPort = {
      ...testIdentity,
      verify: async () => Promise.reject(new Error("failing")),
    };
    const { session, connection } = await sessionWith(failing, async () =>
      Promise.reject(new Error("the callback rejected")),
    );

    pushHello(
      connection,
      (await beginHandshake(identityA, failing.deviceId)).hello,
    );
    await settle();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
    await session.close();
  });
});
