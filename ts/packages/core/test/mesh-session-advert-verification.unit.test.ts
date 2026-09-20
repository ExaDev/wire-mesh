// The session's side of wire-mesh#225: a session verifies every gossiped advert itself before applying it to its directory, rather than trusting whatever forwarded it. The hub it is usually talking to is a facilitator for the directory, never an authority over it, so a receiver that took the hub's word for an advert would have gained nothing from adverts being signed at all.

import { describe, expect, it } from "vitest";
import { createMeshSession } from "../src/domain/mesh-session.js";
import type { DirectoryEntry } from "../src/domain/mesh-session.js";
import { signPeerAdvert } from "../src/domain/peer-advert.js";
import type { Frame } from "../src/generated/protocol.js";
import {
  fakeTransport,
  gossipFor,
  identityA,
  identityB,
  nthEvent,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";
import {
  peerAdvertFor,
  withBrokenSignature,
} from "./relay-hub-test-helpers.js";

const LOCAL_DOMAINS = ["core/management"];
/** connect() emits connecting and connected, then one tick for the self-advert it sends, then one per frame pushed afterwards. */
const EVENTS_THROUGH_CONNECT = 3;

function isDirectoryEntry(value: unknown): value is DirectoryEntry {
  if (typeof value !== "object" || value === null) return false;
  if (!("device" in value) || !("advert" in value)) return false;
  return (
    value.device instanceof Uint8Array &&
    typeof value.advert === "object" &&
    value.advert !== null
  );
}

function isDirectoryEntryList(
  value: unknown,
): value is readonly DirectoryEntry[] {
  return Array.isArray(value) && value.every(isDirectoryEntry);
}

/** Narrows a session event's directory without an assertion, so a malformed event fails the test loudly rather than quietly comparing against nothing. */
function directoryOf(event: unknown): readonly DirectoryEntry[] {
  if (typeof event !== "object" || event === null || !("directory" in event)) {
    throw new Error("session event carries no directory");
  }
  const { directory } = event;
  if (!isDirectoryEntryList(directory)) {
    throw new Error("session event's directory is not a list of entries");
  }
  return directory;
}

/** Starts a connected session over a fake transport and hands back the connection the test pushes gossip onto. */
async function connectedSession(): Promise<
  ReturnType<typeof fakeTransport> & {
    session: ReturnType<typeof createMeshSession>;
  }
> {
  const { transport, connection } = fakeTransport();
  const session = createMeshSession(transport, testIdentity, testClock);
  await session.connect("ws://node", LOCAL_DOMAINS);
  return { transport, connection, session };
}

describe("a mesh session verifies gossiped adverts before its directory sees them", () => {
  it("applies an advert genuinely signed by the device it names", async () => {
    const { connection, session } = await connectedSession();
    connection.push(await gossipFor(identityA));

    const event = await nthEvent(session, EVENTS_THROUGH_CONNECT + 1);
    expect(directoryOf(event).map((entry) => entry.device)).toEqual([
      identityA.deviceId,
    ]);
    await session.close();
  });

  it("never lets an advert with a broken signature into the directory", async () => {
    const { connection, session } = await connectedSession();
    const forged = withBrokenSignature(await peerAdvertFor(identityA));
    connection.push({ type: "gossip", peers: [forged] });

    const event = await nthEvent(session, EVENTS_THROUGH_CONNECT + 1);
    expect(
      directoryOf(event),
      "a forged advert must leave the directory untouched",
    ).toEqual([]);
    await session.close();
  });

  it("never lets an advert whose key does not hash to the named device into the directory", async () => {
    const { connection, session } = await connectedSession();
    // Really signed, by a real key, but naming a device that key does not derive: the case a signature check alone would wave through.
    const impersonation = await signPeerAdvert(identityA, {
      device: identityB.deviceId,
      addresses: ["203.0.113.5:4433"],
      "snapshot-seconds": 1861833600,
      "identity-key": identityA.identityKey,
    });
    connection.push({ type: "gossip", peers: [impersonation] });

    const event = await nthEvent(session, EVENTS_THROUGH_CONNECT + 1);
    expect(directoryOf(event)).toEqual([]);
    await session.close();
  });

  it("keeps the valid adverts of a frame that also carries an invalid one", async () => {
    const { connection, session } = await connectedSession();
    const valid = await peerAdvertFor(identityA);
    const broken = withBrokenSignature(await peerAdvertFor(identityB));
    const mixed: Frame = { type: "gossip", peers: [broken, valid] };
    connection.push(mixed);

    const event = await nthEvent(session, EVENTS_THROUGH_CONNECT + 1);
    expect(directoryOf(event).map((entry) => entry.device)).toEqual([
      identityA.deviceId,
    ]);
    await session.close();
  });

  it("sends a self-advert that a receiver can actually verify", async () => {
    const { connection, session } = await connectedSession();
    // The handshake goes out first, then the self-advert: whatever this session broadcasts about itself has to satisfy the very rule it applies to everyone else, or no peer would ever record it.
    const selfAdvert = connection.sent.find(
      (frame): frame is Extract<Frame, { type: "gossip" }> =>
        frame.type === "gossip",
    );
    expect(
      selfAdvert,
      "the session must send a self-advert on connect",
    ).toBeDefined();
    const advert = selfAdvert?.peers[0];
    expect(advert?.device).toEqual(testIdentity.deviceId);
    expect(advert?.["identity-key"]).toEqual(testIdentity.identityKey);

    const { connection: peerConnection, session: peerSession } =
      await connectedSession();
    if (selfAdvert === undefined) {
      throw new Error("no self-advert to replay");
    }
    peerConnection.push(selfAdvert);
    const event = await nthEvent(peerSession, EVENTS_THROUGH_CONNECT + 1);
    expect(directoryOf(event).map((entry) => entry.device)).toEqual([
      testIdentity.deviceId,
    ]);
    await Promise.all([session.close(), peerSession.close()]);
  });
});
