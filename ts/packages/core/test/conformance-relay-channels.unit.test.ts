/* Runs the `handshake_scenarios` section of conformance/secure-channel.v1.json against the real `createRelayChannels`: each scenario's parties are built from its identities, their handshakes begin from the fixed ephemeral keys the file names (so every hello is the same bytes the file holds), and the steps run one at a time to quiescence on a manual clock. After each step what changed is compared with what the file expects: the hellos sent (by the handshake each belongs to), the seals that completed with the counter of every frame, the seals that failed, the frame an open produced and the faults reported. The schemas are strict, so a field this test does not read fails it. */

import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cdeDecodeOptions, decode } from "cbor2";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  deriveDeviceId,
  verifyWithPublicKey,
} from "../src/adapters/node-identity.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import { createRelayChannels } from "../src/domain/relay-channels.js";
import type { RelayChannels } from "../src/domain/relay-channels.js";
import type { PendingHandshake } from "../src/domain/secure-channel.js";
import {
  frameSchema,
  type DeviceId,
  type Frame,
  type SecureDataFrame,
  type SecureHelloFrame,
} from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import { bytesFromHex } from "./hex.js";
import { ManualClock } from "./relay-channels-harness.js";
import { inSequence, repeatInSequence } from "./sequence.js";

const LAYOUT_VERSION = 1;
const COORDINATE_BYTE_LENGTH = 32;
const SETTLE_ROUNDS = 400;
const SETTLE_POLL_MS = 5;
const SETTLE_GRACE_MS = 15;
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
const SCRIPTED_FAILURE = "scripted failure";

const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/u);
const party = z.enum(["a", "b"]);
const identityName = z.enum(["a", "b", "c"]);
const claim = z.enum(["sender", "none", "a", "b", "c"]);

const expectSchema = z.strictObject({
  hellos: z.array(z.string()),
  sealed: z.array(
    z.strictObject({ seal: z.string(), counters: z.array(z.string()) }),
  ),
  failed: z.array(
    z.strictObject({
      seal: z.string(),
      kind: z.enum(["abandoned", "handshake_failed"]),
    }),
  ),
  opened: z.strictObject({ from: party, frame: z.string() }).nullable(),
  faults: z.array(
    z.strictObject({ peer: party, suppressed: z.number().int() }),
  ),
});

const stepSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("seal"),
    seal: z.string(),
    party,
    to: party,
    purpose: z.enum(["request", "reply"]),
    frame: z.string(),
    expect: expectSchema,
  }),
  z.strictObject({
    op: z.literal("hello"),
    handshake: z.string(),
    claimed: claim,
    expect: expectSchema,
  }),
  z.strictObject({
    op: z.literal("extra_hello"),
    hello: z.string(),
    to: party,
    claimed: claim,
    expect: expectSchema,
  }),
  z.strictObject({
    op: z.literal("data"),
    seal: z.string(),
    index: z.number().int(),
    to: party,
    expect: expectSchema,
  }),
  z.strictObject({
    op: z.literal("advance"),
    ms: z.number().int(),
    expect: expectSchema,
  }),
  z.strictObject({
    op: z.literal("forget"),
    party,
    peer: party,
    expect: expectSchema,
  }),
  z.strictObject({ op: z.literal("reset"), party, expect: expectSchema }),
  z.strictObject({
    op: z.literal("fail"),
    party,
    what: z.enum(["send", "sign"]),
    enabled: z.boolean(),
    expect: expectSchema,
  }),
]);

const handshakeSchema = z.strictObject({
  name: z.string(),
  party,
  to: party,
  ephemeral_secret_hex: hexString,
  ephemeral_public_hex: hexString,
  nonce_hex: hexString,
  hello_vector: z.string(),
});

const scenarioSchema = z.strictObject({
  name: z.string(),
  handshakes: z.array(handshakeSchema),
  extra_hellos: z.array(
    z.strictObject({
      name: z.string(),
      from: party,
      to: identityName,
      hello_vector: z.string(),
    }),
  ),
  steps: z.array(stepSchema),
});

const identitySchema = z.strictObject({
  name: identityName,
  alg: z.number().int(),
  secret_hex: hexString,
  public_key_hex: hexString,
  device_id_hex: hexString,
});

const fileSchema = z.object({
  vectors: z.array(z.object({ name: z.string(), wire_hex: hexString })),
  handshake_scenarios: z.strictObject({
    layout_version: z.literal(LAYOUT_VERSION),
    identities: z.array(identitySchema),
    frames: z.record(z.string(), hexString),
    scenarios: z.array(scenarioSchema),
    counts: z.strictObject({ scenarios: z.number().int() }),
  }),
});

type Scenario = z.infer<typeof scenarioSchema>;
type Step = z.infer<typeof stepSchema>;
type Party = z.infer<typeof party>;
type IdentityName = z.infer<typeof identityName>;
type Claim = z.infer<typeof claim>;

const file = fileSchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../../conformance/secure-channel.v1.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ),
);
const section = file.handshake_scenarios;

function frameFromHex(wireHex: string): Frame {
  return frameSchema.parse(decode(bytesFromHex(wireHex), cdeDecodeOptions));
}

function helloFromVector(name: string): SecureHelloFrame {
  const vector = file.vectors.find((entry) => entry.name === name);
  if (vector === undefined) {
    throw new Error(`no vector ${name}`);
  }
  const frame = frameFromHex(vector.wire_hex);
  if (frame.type !== "secure-hello") {
    throw new Error(`${name} is not a secure-hello`);
  }

  return frame;
}

function identityNamed(name: IdentityName): z.infer<typeof identitySchema> {
  const found = section.identities.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`no identity ${name}`);
  }

  return found;
}

function deviceOf(name: IdentityName): DeviceId {
  return bytesFromHex(identityNamed(name).device_id_hex);
}

function nameOfDevice(device: DeviceId): Party {
  const hexId = deviceIdToHex(device);
  const found = section.identities.find(
    (entry) => entry.device_id_hex === hexId && entry.name !== "c",
  );
  if (found === undefined || found.name === "c") {
    throw new Error(`no party has device ${hexId}`);
  }

  return found.name;
}

/** An identity whose signing key is the seed the file names, so every signature it makes is the one the file holds. */
function identityPort(
  name: IdentityName,
  fails: Readonly<{ sign: boolean }>,
): IdentityPort {
  const identity = identityNamed(name);
  const key = createPrivateKey({
    key: Buffer.from(PKCS8_ED25519_PREFIX + identity.secret_hex, "hex"),
    format: "der",
    type: "pkcs8",
  });

  return {
    deviceId: bytesFromHex(identity.device_id_hex),
    identityKey: {
      alg: identity.alg,
      "public-key": bytesFromHex(identity.public_key_hex),
    },
    sign: async (data) =>
      fails.sign
        ? Promise.reject(new Error(SCRIPTED_FAILURE))
        : Promise.resolve(new Uint8Array(nodeSign(null, data, key))),
    verify: verifyWithPublicKey,
    deriveDeviceId,
  };
}

/** The ephemeral private key a handshake announced, rebuilt from its fixed scalar. */
async function pendingFor(
  spec: Scenario["handshakes"][number],
  peer: DeviceId,
): Promise<PendingHandshake> {
  const publicKey = bytesFromHex(spec.ephemeral_public_hex);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: Buffer.from(spec.ephemeral_secret_hex, "hex").toString("base64url"),
      x: Buffer.from(
        publicKey.subarray(1, 1 + COORDINATE_BYTE_LENGTH),
      ).toString("base64url"),
      y: Buffer.from(publicKey.subarray(1 + COORDINATE_BYTE_LENGTH)).toString(
        "base64url",
      ),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );

  return { peer, hello: helloFromVector(spec.hello_vector), privateKey };
}

/** Lets what a step queued run: the ciphers are asynchronous and take real time, so the step is waited on until it has changed what the file says it changes (or a bound has passed), and then for a moment longer, so something it should not have changed is seen too. */
async function settle(done: () => boolean): Promise<void> {
  await repeatInSequence(SETTLE_ROUNDS, async () => {
    if (!done()) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, SETTLE_POLL_MS);
      });
    }
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SETTLE_GRACE_MS);
  });
}

interface Side {
  readonly fails: { sign: boolean; send: boolean };
  readonly channels: RelayChannels;
  readonly deviceId: DeviceId;
}

/** Everything a step changes, in the form the file records it. */
interface Delta {
  hellos: string[];
  sealed: { seal: string; counters: string[] }[];
  failed: { seal: string; kind: "abandoned" | "handshake_failed" }[];
  opened: { from: Party; frame: string } | null;
  faults: { peer: Party; suppressed: number }[];
}

function emptyDelta(): Delta {
  return { hellos: [], sealed: [], failed: [], opened: null, faults: [] };
}

function bySeal(
  left: Readonly<{ seal: string }>,
  right: Readonly<{ seal: string }>,
): number {
  return left.seal.localeCompare(right.seal);
}

function frameName(frame: Frame): string {
  const found = Object.entries(section.frames).find(
    ([, wire]) => JSON.stringify(frameFromHex(wire)) === JSON.stringify(frame),
  );
  if (found === undefined) {
    throw new Error("an opened frame is none of the file's frames");
  }

  return found[0];
}

function claimedFrom(sender: DeviceId, claimed: Claim): DeviceId | undefined {
  if (claimed === "sender") {
    return sender;
  }

  return claimed === "none" ? undefined : deviceOf(claimed);
}

function frameOf(name: string): Frame {
  const wire = section.frames[name];
  if (wire === undefined) {
    throw new Error(`no frame ${name}`);
  }

  return frameFromHex(wire);
}

class ScenarioRun {
  private delta = emptyDelta();

  private readonly clock = new ManualClock();

  private readonly sides = new Map<Party, Side>();

  private readonly handshakeByKey = new Map<string, string>();

  private readonly sent: {
    name: string;
    from: Party;
    to: Party;
    hello: SecureHelloFrame;
  }[] = [];

  private readonly sealedFrames = new Map<
    string,
    { from: Party; data: SecureDataFrame[] }
  >();

  private readonly ordinals = new Map<string, number>();

  constructor(private readonly scenario: Scenario) {
    for (const name of ["a", "b"] as const) {
      this.sides.set(name, this.build(name));
    }
  }

  private build(name: Party): Side {
    const fails = { sign: false, send: false };
    const identity = identityPort(name, fails);
    const channels = createRelayChannels(
      identity,
      async (peer, hello) => {
        if (fails.send) {
          return Promise.reject(new Error(SCRIPTED_FAILURE));
        }
        const handshake = this.handshakeByKey.get(
          Buffer.from(hello["ephemeral-key"]).toString("hex"),
        );
        if (handshake === undefined) {
          throw new Error(
            "a hello was sent that no handshake of the file made",
          );
        }
        this.sent.push({
          name: handshake,
          from: name,
          to: nameOfDevice(peer),
          hello,
        });
        this.delta.hellos.push(handshake);

        return Promise.resolve();
      },
      {
        clock: this.clock,
        newHandshake: async (peer) => this.begin(name, fails, peer),
        onFault: (_error, context) => {
          this.delta.faults.push({
            peer: nameOfDevice(context.peer ?? deviceOf("c")),
            suppressed: context.suppressed,
          });
        },
      },
    );

    return { fails, channels, deviceId: identity.deviceId };
  }

  private async begin(
    name: Party,
    fails: Readonly<{ sign: boolean }>,
    peer: DeviceId,
  ): Promise<PendingHandshake> {
    if (fails.sign) {
      throw new Error(SCRIPTED_FAILURE);
    }
    const key = `${name}>${nameOfDevice(peer)}`;
    const ordinal = this.ordinals.get(key) ?? 0;
    this.ordinals.set(key, ordinal + 1);
    const wanted = `${key}#${String(ordinal)}`;
    const spec = this.scenario.handshakes.find(
      (entry) => entry.name === wanted,
    );
    if (spec === undefined) {
      throw new Error(`the scenario has no handshake ${wanted}`);
    }
    this.handshakeByKey.set(spec.ephemeral_public_hex, spec.name);

    return pendingFor(spec, peer);
  }

  private side(name: Party): Side {
    const found = this.sides.get(name);
    if (found === undefined) {
      throw new Error(`no side ${name}`);
    }

    return found;
  }

  private seal(step: Extract<Step, { op: "seal" }>): void {
    void this.side(step.party)
      .channels.seal(deviceOf(step.to), frameOf(step.frame), step.purpose)
      .then(
        (frames) => {
          this.sealedFrames.set(step.seal, {
            from: step.party,
            data: [...frames],
          });
          this.delta.sealed.push({
            seal: step.seal,
            counters: frames.map((data) => String(data.counter)),
          });
        },
        (error: unknown) => {
          this.delta.failed.push({
            seal: step.seal,
            kind:
              error instanceof Error && error.message === SCRIPTED_FAILURE
                ? "handshake_failed"
                : "abandoned",
          });
        },
      );
  }

  private async deliver(step: Extract<Step, { op: "data" }>): Promise<void> {
    const held = this.sealedFrames.get(step.seal);
    const data = held?.data[step.index];
    if (held === undefined || data === undefined) {
      throw new Error(`${step.seal} sealed no frame ${String(step.index)}`);
    }
    const opened = await this.side(step.to).channels.open(
      data,
      deviceOf(held.from),
    );
    this.delta.opened =
      opened === undefined
        ? null
        : { from: nameOfDevice(opened.from), frame: frameName(opened.frame) };
  }

  private async run(step: Step): Promise<void> {
    switch (step.op) {
      case "seal":
        this.seal(step);

        return;
      case "hello": {
        const sent = this.sent.find((entry) => entry.name === step.handshake);
        if (sent === undefined) {
          throw new Error(`${step.handshake} was never sent`);
        }
        await this.side(sent.to).channels.applyHello(
          sent.hello,
          claimedFrom(this.side(sent.from).deviceId, step.claimed),
        );

        return;
      }
      case "extra_hello": {
        const extra = this.scenario.extra_hellos.find(
          (entry) => entry.name === step.hello,
        );
        if (extra === undefined) {
          throw new Error(`no extra hello ${step.hello}`);
        }
        await this.side(step.to).channels.applyHello(
          helloFromVector(extra.hello_vector),
          claimedFrom(deviceOf(extra.from), step.claimed),
        );

        return;
      }
      case "data":
        await this.deliver(step);

        return;
      case "advance":
        this.clock.advance(step.ms);

        return;
      case "forget":
        this.side(step.party).channels.forget(deviceOf(step.peer));

        return;
      case "reset":
        this.side(step.party).channels.reset("the session was reset");

        return;
      case "fail":
        this.side(step.party).fails[step.what] = step.enabled;
    }
  }

  async play(): Promise<void> {
    await inSequence(this.scenario.steps, async (step, index) => {
      this.delta = emptyDelta();
      await this.run(step);
      const normal = (delta: Delta): Delta => ({
        ...delta,
        sealed: [...delta.sealed].sort(bySeal),
        failed: [...delta.failed].sort(bySeal),
      });
      const expected = normal(step.expect);
      await settle(
        () => JSON.stringify(normal(this.delta)) === JSON.stringify(expected),
      );
      expect(normal(this.delta), `step ${String(index)} (${step.op})`).toEqual(
        expected,
      );
    });
  }
}

describe("the file's own accounting", () => {
  it("holds the number of scenarios its header says", () => {
    expect(section.scenarios).toHaveLength(section.counts.scenarios);
  });

  it("holds identities that are the seeds' own keys", () => {
    for (const identity of section.identities) {
      const port = identityPort(identity.name, { sign: false });
      expect(Buffer.from(port.deviceId).toString("hex")).toBe(
        identity.device_id_hex,
      );
    }
  });
});

describe("the per-peer secure channel state machine", () => {
  for (const scenario of section.scenarios) {
    it(scenario.name, async () => {
      await new ScenarioRun(scenario).play();
    });
  }
});
