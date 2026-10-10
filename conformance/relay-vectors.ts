// The relay frames' vectors (spec/transport.cddl's relay role), kept out of generate.ts the same way token-vectors.ts and adverts.ts are: generate.ts sits at this repo's own max-lines cap. The synthetic identities and the CDE hex encoder arrive via the context parameter so this file adds no second copy of them.

import { hex, type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";

/** What generate.ts already defines and the relay vectors reuse. */
export interface RelayVectorContext {
  readonly deviceB: JsonWire;
  readonly deviceC: JsonWire;
  readonly wireHex: (message: JsonWire) => string;
  /** Length of the arbitrary example ciphertext a relay-data-frame carries. */
  readonly payloadByteLength: number;
}

export function relayVectors(ctx: Readonly<RelayVectorContext>): Vector[] {
  const vector = (name: string, message: JsonWire): Vector => ({
    name,
    message,
    wire_hex: ctx.wireHex(message),
  });
  const payload = hex("de".repeat(ctx.payloadByteLength));

  return [
    vector("relay_offer_v1", {
      type: "relay-offer",
      addresses: ["198.51.100.2:7000"],
    }),
    vector("relay_connect_v1", {
      type: "relay-connect",
      "target-device": ctx.deviceC,
    }),
    // A gateway fronting the device named by source-device initiates on its behalf.
    vector("relay_connect_v1_fronted", {
      type: "relay-connect",
      "target-device": ctx.deviceC,
      "source-device": ctx.deviceB,
    }),
    vector("relay_data_v1", { type: "relay-data", payload }),
    vector("relay_data_v1_addressed", {
      type: "relay-data",
      payload,
      "to-device": ctx.deviceC,
      "from-device": ctx.deviceB,
    }),
    vector("relay_inbound_v1", {
      type: "relay-inbound",
      "source-device": ctx.deviceB,
    }),
    // target-device names which of a fronting connection's devices the pairing is for.
    vector("relay_inbound_v1_fronted", {
      type: "relay-inbound",
      "source-device": ctx.deviceB,
      "target-device": ctx.deviceC,
    }),
  ];
}
