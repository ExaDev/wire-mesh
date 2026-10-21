// Verifying a gossiped advert is two digests-worth of work plus a public-key import and a signature check, and a hub hands the same advert to a receiver again on every re-broadcast and every catch-up. These tests count the checks actually run (never time) to pin that a repeat of an advert already judged costs none, and that nothing but a genuine verdict is ever remembered.

import { describe, expect, it } from "vitest";
import { createMeshSession } from "../src/domain/mesh-session.js";
import { createRelayHub } from "../src/domain/relay-hub.js";
import {
  verifyPeerAdvert,
  type PeerAdvertVerifier,
} from "../src/domain/peer-advert.js";
import type { PeerAdvert } from "../src/generated/protocol.js";
import {
  fakeTransport,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";
import {
  createTestPeer,
  FakeConnection,
  gossipForMany,
  hubVerifier,
  settle,
  withBrokenSignature,
} from "./relay-hub-test-helpers.js";
import { repeatInSequence } from "./sequence.js";

/** Peers in the simulated mesh. Several, so a count proportional to peers times repeats cannot be mistaken for a constant. */
const PEERS = 6;
/** Times each peer's unchanged advert reaches the receiver: its own re-gossip, a hub's re-broadcast, a catch-up. */
const REPEATS = 5;
const ONE_CHECK = 1;
const SECOND_ATTEMPT = 2;
const LOCAL_DOMAINS = ["core/management"];

/** A verifier that counts the checks it is asked to run. A fresh one each time, because a verifier's memo is its own. */
function countingVerifier(): {
  verifier: PeerAdvertVerifier;
  verifications: () => number;
  derivations: () => number;
} {
  let verifications = 0;
  let derivations = 0;

  return {
    verifier: {
      verify: async (...args) => {
        verifications += 1;

        return hubVerifier.verify(...args);
      },
      deriveDeviceId: async (...args) => {
        derivations += 1;

        return hubVerifier.deriveDeviceId(...args);
      },
    },
    verifications: () => verifications,
    derivations: () => derivations,
  };
}

async function adverts(count: number): Promise<PeerAdvert[]> {
  return Promise.all(
    Array.from({ length: count }, async () => (await createTestPeer()).advert),
  );
}

async function oneAdvert(): Promise<PeerAdvert> {
  const [advert] = await adverts(ONE_CHECK);
  if (advert === undefined) throw new Error("test setup: no advert");

  return advert;
}

describe("verifyPeerAdvert remembers verdicts it has reached", () => {
  it("checks an advert once however many times it arrives", async () => {
    const counting = countingVerifier();
    const advert = await oneAdvert();

    await repeatInSequence(REPEATS, async () => {
      expect(await verifyPeerAdvert(counting.verifier, advert)).toBe(true);
    });

    expect(counting.verifications()).toBe(ONE_CHECK);
    expect(counting.derivations()).toBe(ONE_CHECK);
  });

  it("shares one check between concurrent arrivals of the same advert", async () => {
    const counting = countingVerifier();
    const advert = await oneAdvert();

    const verdicts = await Promise.all(
      Array.from({ length: REPEATS }, async () =>
        verifyPeerAdvert(counting.verifier, advert),
      ),
    );

    expect(verdicts).toEqual(Array.from({ length: REPEATS }, () => true));
    expect(counting.verifications()).toBe(ONE_CHECK);
  });

  it("remembers a refusal, so a replayed forgery is not re-verified either", async () => {
    const counting = countingVerifier();
    const forged = withBrokenSignature(await oneAdvert());

    await repeatInSequence(REPEATS, async () => {
      expect(await verifyPeerAdvert(counting.verifier, forged)).toBe(false);
    });

    expect(counting.verifications()).toBe(ONE_CHECK);
  });

  it("never lets a remembered verdict stand in for a different advert", async () => {
    const counting = countingVerifier();
    const advert = await oneAdvert();

    expect(await verifyPeerAdvert(counting.verifier, advert)).toBe(true);
    expect(
      await verifyPeerAdvert(counting.verifier, withBrokenSignature(advert)),
      "the genuine advert's verdict must not answer for a forgery that differs only in its signature",
    ).toBe(false);
    expect(
      await verifyPeerAdvert(counting.verifier, {
        ...advert,
        addresses: ["198.51.100.7:1"],
      }),
      "nor for the same signature over different signed content",
    ).toBe(false);
  });

  it("does not remember a check that threw, so the same bytes are tried again", async () => {
    const advert = await oneAdvert();
    let attempts = 0;
    const flaky: PeerAdvertVerifier = {
      deriveDeviceId: hubVerifier.deriveDeviceId,
      verify: async (...args) => {
        attempts += 1;
        if (attempts === ONE_CHECK) throw new Error("transient crypto failure");

        return hubVerifier.verify(...args);
      },
    };

    expect(await verifyPeerAdvert(flaky, advert)).toBe(false);
    expect(await verifyPeerAdvert(flaky, advert)).toBe(true);
    expect(attempts).toBe(SECOND_ATTEMPT);
  });
});

describe("a mesh of peers gossiping through one hub", () => {
  it("makes the hub check each peer's advert once, however often it is re-sent", async () => {
    const counting = countingVerifier();
    const hub = createRelayHub({ identity: counting.verifier });
    const peers = await adverts(PEERS);
    const clients = peers.map(() => new FakeConnection());
    const handling = clients.map(async (client) =>
      hub.handleConnection(client.connection),
    );

    await repeatInSequence(REPEATS, async () => {
      peers.forEach((advert, index) => {
        clients[index]?.push(gossipForMany(advert));
      });
      await settle(...clients);
    });

    expect(counting.verifications()).toBe(PEERS);

    await Promise.all(clients.map(async (client) => client.end()));
    await Promise.all(handling);
  });

  it("makes a session check each advert once when its hub replays the directory again and again", async () => {
    const counting = countingVerifier();
    const { transport, connection } = fakeTransport();
    const peers = await adverts(PEERS);
    const expectedApplications = PEERS * REPEATS;
    let applied = 0;
    const allApplied = Promise.withResolvers<undefined>();
    const session = createMeshSession(
      transport,
      {
        ...testIdentity,
        verify: counting.verifier.verify,
        deriveDeviceId: counting.verifier.deriveDeviceId,
      },
      testClock,
      null,
      [],
      () => {
        applied += 1;
        if (applied === expectedApplications) allApplied.resolve(undefined);
      },
    );
    await session.connect("ws://node", LOCAL_DOMAINS);

    await repeatInSequence(REPEATS, async () => {
      connection.push(gossipForMany(...peers));

      return Promise.resolve();
    });
    await allApplied.promise;

    expect(counting.verifications()).toBe(PEERS);
    await session.close();
  });
});
