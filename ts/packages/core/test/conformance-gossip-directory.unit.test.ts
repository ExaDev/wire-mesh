/* Checks every case of conformance/gossip-directory.v1.json against the real session and the real extension validation:

   - each key bag is accepted, or refused with the reason the file names for the first key refused;
   - each scenario delivers its gossip frames to a connected session in order and compares the directory it holds after each frame, as the devices and snapshot times in first-heard order (a scenario marked `rust_only` pins a bound only the Rust session applies and is skipped);
   - each self-advert case builds the session's own advert under the file's identity and clock and compares its device, addresses, snapshot time, the keys of its open tail and its topology, then verifies its signature;
   - every list holds the number of entries the file's header says.

   Not compared, because they only name: every `name`, and the layout version (checked to be the one this test reads). The TypeScript session reports no outcome per advert, so the outcomes the file records are checked by the Rust runner only. The version an advert reports is this package's own and is compared with it, not with the file. */

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cdeDecodeOptions, decode } from "cbor2";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import { bytesToHex } from "../src/domain/device-id.js";
import { validateGossipExtensions } from "../src/domain/gossip-extensions.js";
import { createMeshSession } from "../src/domain/mesh-session.js";
import { readTopologyPeers } from "../src/domain/topology.js";
import { frameSchema, type Frame } from "../src/generated/protocol.js";
import { eachInOrder } from "../src/domain/sequential.js";
import { bytesFromHex } from "./hex.js";
import { repeatInSequence } from "./sequence.js";
import {
  fakeTransport,
  MS_PER_SECOND,
  OWN_VERSION,
  testClock,
} from "./mesh-session-fixtures.js";
import { verifyPeerAdvert } from "../src/domain/peer-advert.js";

const LAYOUT_VERSION = 1;
const EDDSA = -8;
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
const EVENTS_THROUGH_CONNECT = 3;
const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/);

const file = z
  .object({
    vectors: z.array(z.looseObject({ name: z.string(), wire_hex: hexString })),
    gossip_directory: z.strictObject({
      layout_version: z.literal(LAYOUT_VERSION),
      identities: z.array(
        z.strictObject({
          name: z.string(),
          secret_hex: hexString,
          public_key_hex: hexString,
          device_id_hex: hexString,
        }),
      ),
      extension_validation: z.array(
        z.strictObject({
          name: z.string(),
          keys: z.array(z.string()),
          refused: z
            .strictObject({ key: z.string(), reason: z.string() })
            .nullable(),
        }),
      ),
      directory_scenarios: z.array(
        z.strictObject({
          name: z.string(),
          rust_only: z.boolean(),
          steps: z.array(
            z.strictObject({
              vector: z.string(),
              outcomes: z.array(z.string()),
              directory: z.array(
                z.strictObject({
                  device: hexString,
                  snapshot_seconds: z.number().int(),
                }),
              ),
            }),
          ),
        }),
      ),
      self_adverts: z.array(
        z.strictObject({
          name: z.string(),
          identity: z.string(),
          extensions: z.record(z.string(), z.string()),
          now_seconds: z.number().int(),
          expected: z.strictObject({
            device_hex: hexString,
            addresses: z.array(z.string()),
            snapshot_seconds: z.number().int(),
            extension_keys: z.array(z.string()),
            topology: z.strictObject({
              direct: z.array(z.string()),
              relayed: z.array(z.string()),
            }),
          }),
        }),
      ),
      counts: z.strictObject({
        extension_validation: z.number().int(),
        directory_scenarios: z.number().int(),
        self_adverts: z.number().int(),
      }),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../conformance/gossip-directory.v1.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ),
  );
const section = file.gossip_directory;

function frameOf(vector: string): Frame {
  const held = file.vectors.find((candidate) => candidate.name === vector);
  if (held === undefined) {
    throw new Error(`no vector ${vector}`);
  }

  return frameSchema.parse(
    decode(bytesFromHex(held.wire_hex), cdeDecodeOptions),
  );
}

async function identityNamed(name: string) {
  const held = section.identities.find((candidate) => candidate.name === name);
  if (held === undefined) {
    throw new Error(`no identity ${name}`);
  }
  const privateKey = await webcrypto.subtle.importKey(
    "pkcs8",
    bytesFromHex(PKCS8_ED25519_PREFIX + held.secret_hex),
    { name: "Ed25519" },
    false,
    ["sign"],
  );

  return createNodeIdentity(
    privateKey,
    bytesFromHex(held.public_key_hex),
    EDDSA,
  );
}

describe("the gossip-directory vectors", () => {
  it("hold the number of entries their header says", () => {
    expect(section.extension_validation.length).toBe(
      section.counts.extension_validation,
    );
    expect(section.directory_scenarios.length).toBe(
      section.counts.directory_scenarios,
    );
    expect(section.self_adverts.length).toBe(section.counts.self_adverts);
  });

  it("have identities whose secrets give the public keys and device ids the file names", async () => {
    await eachInOrder(section.identities, async (held) => {
      const identity = await identityNamed(held.name);
      expect(bytesToHex(identity.identityKey["public-key"])).toBe(
        held.public_key_hex,
      );
      expect(bytesToHex(identity.deviceId)).toBe(held.device_id_hex);
    });
  });

  describe("extension validation", () => {
    for (const held of section.extension_validation) {
      it(held.name, () => {
        const bag: Record<string, unknown> = {};
        for (const key of held.keys) {
          bag[key] = null;
        }
        if (held.refused === null) {
          expect(() => {
            validateGossipExtensions(bag);
          }).not.toThrow();

          return;
        }
        const pattern = {
          reserved_field: /collides with a mandatory peer-advert field/,
          session_managed: /collides with a session-managed gossip field/,
          reserved_version: /reserved for wire-mesh-core's own/,
          not_domain_qualified: /must be domain-qualified/,
        }[held.refused.reason];
        expect(pattern).toBeDefined();
        expect(() => {
          validateGossipExtensions(bag);
        }).toThrow(`"${held.refused.key}"`);
        expect(() => {
          validateGossipExtensions(bag);
        }).toThrow(pattern);
      });
    }
  });

  describe("directory scenarios", () => {
    for (const scenario of section.directory_scenarios) {
      it.skipIf(scenario.rust_only)(scenario.name, async () => {
        const me = await identityNamed("me");
        const { transport, connection } = fakeTransport();
        const session = createMeshSession(transport, me, testClock);
        await session.connect("ws://node", ["core/data"]);
        const events = session.events[Symbol.asyncIterator]();
        await repeatInSequence(EVENTS_THROUGH_CONNECT, async () => {
          await events.next();
        });
        await eachInOrder(scenario.steps, async (step) => {
          connection.push(frameOf(step.vector));
          const event = (await events.next()).value as {
            directory: {
              device: Uint8Array;
              advert: Record<string, unknown>;
            }[];
          };
          expect(
            event.directory.map((entry) => ({
              device: bytesToHex(entry.device),
              snapshot_seconds: entry.advert["snapshot-seconds"],
            })),
          ).toEqual(step.directory);
        });
        await session.close();
      });
    }
  });

  describe("self adverts", () => {
    for (const held of section.self_adverts) {
      it(held.name, async () => {
        const identity = await identityNamed(held.identity);
        const { transport, connection } = fakeTransport();
        const session = createMeshSession(transport, identity, {
          now: () => held.now_seconds * MS_PER_SECOND,
        });
        await session.connect("ws://node", ["core/data"]);
        if (Object.keys(held.extensions).length > 0) {
          await session.sendGossipUpdate(held.extensions);
        }
        const sent = connection.sent.at(-1);
        if (sent?.type !== "gossip") {
          throw new Error("the session sent no gossip");
        }
        const advert = sent.peers[0];
        if (advert === undefined) {
          throw new Error("the gossip held no advert");
        }
        const mandatory = [
          "device",
          "addresses",
          "snapshot-seconds",
          "identity-key",
          "signature",
        ];
        expect(bytesToHex(advert.device)).toBe(held.expected.device_hex);
        expect(advert.addresses).toEqual(held.expected.addresses);
        expect(advert["snapshot-seconds"]).toBe(held.expected.snapshot_seconds);
        expect(
          Object.keys(advert)
            .filter((key) => !mandatory.includes(key))
            .sort(),
        ).toEqual(held.expected.extension_keys);
        expect(advert["wire-mesh/version"]).toBe(OWN_VERSION);
        expect(readTopologyPeers(advert)).toEqual({
          direct: held.expected.topology.direct,
          relayed: held.expected.topology.relayed,
        });
        expect(await verifyPeerAdvert(identity, advert)).toBe(true);
        await session.close();
      });
    }
  });
});
