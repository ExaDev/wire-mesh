// Sessions of the published previous release and of this build, through an in-memory hub: what holds between them (spec/secure-channel.cddl). The previous release is the package this one is built from, installed under an alias, so what runs is its published code and not a model of it.

import { describe, expect, it } from "vitest";
import { createMeshSession as createReleased } from "wire-mesh-core-released/domain/mesh-session";
import { createMeshSession as createCurrent } from "../src/domain/mesh-session.js";
import type { ManageOutcome } from "../src/domain/mesh-session.js";
import type {
  CapabilityScope,
  DeviceId,
  ManageCommand,
} from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import { InteropHub } from "./interop-hub.js";
import { fakeTransport, type FakeConnection } from "./mesh-session-fixtures.js";
import { generateEd25519Identity } from "./tokens-fixtures.js";

type Build = "released" | "current";

interface Peer {
  readonly build: Build;
  readonly identity: IdentityPort;
  readonly connection: FakeConnection;
  readonly request: (target: DeviceId) => Promise<ManageOutcome>;
  readonly close: () => Promise<void>;
}

const command: ManageCommand = {
  verb: "exec:proc",
  params: { verb: "exec.list" },
};
const scope: CapabilityScope = { kind: "folder" };
const REQUEST_TIMEOUT_MS = 1_500;
const MOST_ATTEMPTS = 3;
const pairings: readonly (readonly [Build, Build])[] = [
  ["released", "released"],
  ["released", "current"],
  ["current", "released"],
  ["current", "current"],
];

async function start(
  hub: InteropHub,
  build: Build,
  identity: IdentityPort,
): Promise<Peer> {
  const { transport, connection } = fakeTransport();
  hub.attach(identity.deviceId, connection);
  const session =
    build === "released"
      ? createReleased(transport, identity)
      : createCurrent(transport, identity);
  await session.connect("ws://node", ["core/management"]);
  // Answers every request it is sent.
  void (async (): Promise<void> => {
    for await (const incoming of session.incomingManageRequests) {
      await incoming.respond({ result: "ok" });
    }
  })();

  return {
    build,
    identity,
    connection,
    request: async (target) =>
      session.sendManageRequest(
        command,
        scope,
        target,
        undefined,
        REQUEST_TIMEOUT_MS,
      ),
    close: async () => session.close(),
  };
}

/** Requests until one is answered, and how many it took. */
async function attemptsUntilAnswered(
  from: Peer,
  to: Peer,
  made = 1,
): Promise<number> {
  const outcome = await from.request(to.identity.deviceId);
  if (outcome.result === "ok") {
    return made;
  }

  return made >= MOST_ATTEMPTS
    ? Number.POSITIVE_INFINITY
    : attemptsUntilAnswered(from, to, made + 1);
}

describe("sessions of the previous release and of this build", () => {
  for (const [first, second] of pairings) {
    it(`answer each other's requests, ${first} then ${second}`, async () => {
      const hub = new InteropHub();
      const a = await start(hub, first, await generateEd25519Identity());
      const b = await start(hub, second, await generateEd25519Identity());

      expect(await a.request(b.identity.deviceId)).toEqual({ result: "ok" });
      expect(await b.request(a.identity.deviceId)).toEqual({ result: "ok" });
      await a.close();
      await b.close();
    });

    it(`are reachable again after one restarts, ${first} then ${second}`, async () => {
      const hub = new InteropHub();
      const a = await start(hub, first, await generateEd25519Identity());
      const b = await start(hub, second, await generateEd25519Identity());
      expect(await a.request(b.identity.deviceId)).toEqual({ result: "ok" });
      await b.close();
      const restarted = await start(hub, second, b.identity);

      // Whichever side asks first, both can ask within a bounded number of attempts.
      expect(await attemptsUntilAnswered(restarted, a)).toBeLessThanOrEqual(
        MOST_ATTEMPTS,
      );
      expect(await attemptsUntilAnswered(a, restarted)).toBeLessThanOrEqual(
        MOST_ATTEMPTS,
      );
      await a.close();
      await restarted.close();
    });
  }
});

// Only a replay to a session of this build is expected to be recovered from: the previous release has no rule that confirms a channel before it replaces another.
describe("sessions with this build on the replayed side", () => {
  for (const [first, second] of pairings.filter(
    ([build]) => build === "current",
  )) {
    it(`are reachable again after an older hello is replayed, ${first} then ${second}`, async () => {
      const hub = new InteropHub();
      const a = await start(hub, first, await generateEd25519Identity());
      const b = await start(hub, second, await generateEd25519Identity());
      expect(await a.request(b.identity.deviceId)).toEqual({ result: "ok" });
      const [older] = hub.helloFrom(b.identity.deviceId);
      if (older === undefined) {
        throw new Error("no hello was relayed");
      }
      // The second channel is the current one: the hello above is an older hello of the same device.
      await b.close();
      const restarted = await start(hub, second, b.identity);
      expect(await attemptsUntilAnswered(restarted, a)).toBeLessThanOrEqual(
        MOST_ATTEMPTS,
      );
      expect(await attemptsUntilAnswered(a, restarted)).toBeLessThanOrEqual(
        MOST_ATTEMPTS,
      );
      hub.replayTo(a.identity.deviceId, older);

      expect(await attemptsUntilAnswered(a, restarted)).toBeLessThanOrEqual(
        MOST_ATTEMPTS,
      );
      expect(await attemptsUntilAnswered(restarted, a)).toBeLessThanOrEqual(
        MOST_ATTEMPTS,
      );
      await a.close();
      await restarted.close();
    });
  }
});
