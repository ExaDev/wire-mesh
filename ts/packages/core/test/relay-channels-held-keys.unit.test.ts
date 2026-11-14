// Hellos that cannot be answered are dropped before they cost a signature check, and a hello that repeats a key already held is dropped at each of the three places that can see it (spec/secure-channel.cddl, obligations 7 and 9). The relay channels are driven directly, with a counting identity port and a clock the test moves.

import { describe, expect, it, vi } from "vitest";
import {
  CANDIDATES_PER_HANDSHAKE,
  createRelayChannels,
  HANDSHAKE_WINDOW_MS,
  MAX_UNSOLICITED_PEERS,
  type RelayChannels,
} from "../src/domain/relay-channels.js";
import { beginHandshake } from "../src/domain/secure-channel.js";
import type { Frame, SecureHelloFrame } from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import { ManualClock } from "./relay-channels-harness.js";
import { repeatInSequence } from "./sequence.js";
import { generateEd25519Identity } from "./tokens-fixtures.js";

const pong: Frame = { type: "pong" };
const FLOOD = 12;
const EXTRA_IDENTITIES = 10;
const CLOCK_READS_TO_REACH_THE_WAIT = 2;

interface Local {
  readonly channels: RelayChannels;
  readonly clock: ManualClock;
  readonly sent: SecureHelloFrame[];
  readonly verified: () => number;
  /** How many handshakes this side has begun, and how often the channels have read the clock: what a test waits on to know where a delivery has got to. */
  readonly begun: () => number;
  readonly clockReads: () => number;
}

async function local(
  options: Readonly<{
    gateFirstVerify?: PromiseWithResolvers<undefined>;
    /** Held until released: every handshake this side begins waits for it. */
    gateHandshakes?: PromiseWithResolvers<undefined>;
  }> = {},
): Promise<Local & { identity: IdentityPort }> {
  const base = await generateEd25519Identity();
  let verifications = 0;
  const identity: IdentityPort = {
    ...base,
    verify: async (key, data, signature) => {
      verifications += 1;
      if (verifications === 1) {
        await options.gateFirstVerify?.promise;
      }

      return base.verify(key, data, signature);
    },
  };
  const manual = new ManualClock();
  let reads = 0;
  let handshakes = 0;
  const clock = {
    now: (): number => {
      reads += 1;

      return manual.now();
    },
  };
  const sent: SecureHelloFrame[] = [];
  const channels = createRelayChannels(
    identity,
    async (_peer, hello) => {
      sent.push(hello);

      return Promise.resolve();
    },
    {
      clock,
      newHandshake: async (peer) => {
        handshakes += 1;
        await options.gateHandshakes?.promise;

        return beginHandshake(identity, peer);
      },
    },
  );

  return {
    channels,
    clock: manual,
    sent,
    verified: () => verifications,
    begun: () => handshakes,
    clockReads: () => reads,
    identity,
  };
}

async function helloFrom(
  signer: IdentityPort,
  to: IdentityPort,
): Promise<SecureHelloFrame> {
  return (await beginHandshake(signer, to.deviceId)).hello;
}

describe("the candidates a handshake may build", () => {
  it("are two", () => {
    expect(CANDIDATES_PER_HANDSHAKE).toBe(2);
  });
});

describe("hellos that cannot be answered", () => {
  it("from one identity stop costing a signature check once its handshake has its candidates", async () => {
    const { channels, verified, identity } = await local();
    const peer = await generateEd25519Identity();

    await repeatInSequence(FLOOD, async () => {
      await channels.applyHello(await helloFrom(peer, identity), peer.deviceId);
    });

    expect(verified()).toBe(CANDIDATES_PER_HANDSHAKE);
  });

  it("from many identities stop costing a signature check once the unsolicited entries are taken", async () => {
    const { channels, verified, identity } = await local();

    await repeatInSequence(
      MAX_UNSOLICITED_PEERS + EXTRA_IDENTITIES,
      async () => {
        const stranger = await generateEd25519Identity();
        await channels.applyHello(
          await helloFrom(stranger, identity),
          stranger.deviceId,
        );
      },
    );

    expect(verified()).toBe(MAX_UNSOLICITED_PEERS);
  });
});

describe("a hello that repeats a key already held", () => {
  it("is dropped before its signature is checked", async () => {
    const { channels, verified, identity, sent } = await local();
    const peer = await generateEd25519Identity();
    const hello = await helloFrom(peer, identity);
    await channels.applyHello(hello, peer.deviceId);
    // The answer goes out in the background: wait for it, so that what follows is measured against it.
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const checked = verified();
    const answered = sent.length;

    await channels.applyHello(hello, peer.deviceId);

    expect(verified()).toBe(checked);
    expect(sent).toHaveLength(answered);
  });

  it("is dropped after its signature is checked when the key became held meanwhile, without starting an answer", async () => {
    const gate = Promise.withResolvers<undefined>();
    const { channels, clock, sent, identity, verified } = await local({
      gateFirstVerify: gate,
    });
    const peer = await generateEd25519Identity();
    const hello = await helloFrom(peer, identity);

    // The first delivery waits in its signature check while the second is applied in full.
    const first = channels.applyHello(hello, peer.deviceId);
    await vi.waitFor(() => {
      expect(verified()).toBe(1);
    });
    await channels.applyHello(hello, peer.deviceId);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const answered = sent.length;
    // After the window the candidate is the channel and nothing is outstanding, so a hello that would start an answer is the only way to a further hello.
    clock.advance(HANDSHAKE_WINDOW_MS + 1);
    gate.resolve(undefined);
    await first;

    expect(sent).toHaveLength(answered);
  });

  it("is dropped after its channel is built when the same key was added meanwhile, so one candidate stays", async () => {
    const gate = Promise.withResolvers<undefined>();
    const { channels, identity, begun, clockReads } = await local({
      gateHandshakes: gate,
    });
    const peer = await generateEd25519Identity();
    const hello = await helloFrom(peer, identity);

    // The first delivery begins this side's handshake and waits for its own key, as the second is applied.
    const first = channels.applyHello(hello, peer.deviceId);
    await vi.waitFor(() => {
      expect(begun()).toBe(1);
    });
    const readsBefore = clockReads();
    const second = channels.applyHello(hello, peer.deviceId);
    // The second delivery reads the clock before and after its signature check, and its next step is to wait with the first for the handshake's key.
    await vi.waitFor(() => {
      expect(clockReads()).toBe(readsBefore + CLOCK_READS_TO_REACH_THE_WAIT);
    });
    gate.resolve(undefined);
    await Promise.all([first, second]);

    expect(await channels.seal(peer.deviceId, pong, "reply")).toHaveLength(1);
  });
});
