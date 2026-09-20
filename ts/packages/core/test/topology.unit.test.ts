import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityScope,
  DeviceId,
  ManageCommand,
  PeerAdvert,
} from "../src/generated/protocol.js";
import type {
  DirectoryEntry,
  IncomingManageRequest,
  MeshSession,
} from "../src/domain/mesh-session.js";
import {
  assembleTopologyGraph,
  buildTopologyGetCommand,
  createTopologyGetHandler,
  readTopologyPeers,
  sendTopologyGet,
  TOPOLOGY_GET_CAPABILITY,
} from "../src/domain/topology.js";
import { deviceIdFromFillHex } from "./hex.js";
import { syntheticAdvertProof } from "./synthetic-advert.js";

const deviceA = deviceIdFromFillHex("11");
const deviceB = deviceIdFromFillHex("22");
const deviceC = deviceIdFromFillHex("33");

function advertWith(
  device: DeviceId,
  extensions: Record<string, unknown> = {},
): PeerAdvert {
  return {
    device,
    addresses: [],
    "snapshot-seconds": 0,
    ...syntheticAdvertProof(),
    ...extensions,
  };
}

function fakeSession(): MeshSession {
  return {
    sendManageRequest: vi.fn(),
    getTopologyPeers: vi.fn(),
  } as unknown as MeshSession;
}

function fakeIncoming(command: ManageCommand): {
  incoming: IncomingManageRequest;
  respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn(async (): Promise<void> => Promise.resolve());
  const scope: CapabilityScope = { kind: "node" };
  const incoming: IncomingManageRequest = {
    requestId: 0,
    command,
    scope,
    respond,
  };
  return { incoming, respond };
}

describe("buildTopologyGetCommand", () => {
  it("carries the registered topology:get capability as its outer verb", () => {
    expect(buildTopologyGetCommand()).toEqual({
      verb: TOPOLOGY_GET_CAPABILITY,
      params: { verb: "topology.get" },
    } satisfies ManageCommand);
  });
});

describe("readTopologyPeers", () => {
  it("returns undefined when the advert carries no topology/peers extension", () => {
    expect(readTopologyPeers(advertWith(deviceA))).toBeUndefined();
  });

  it("returns undefined for a malformed topology/peers value rather than throwing", () => {
    const malformed = advertWith(deviceA, {
      "topology/peers": { direct: "not-an-array" },
    });
    expect(readTopologyPeers(malformed)).toBeUndefined();
  });

  it("parses a well-formed topology/peers value", () => {
    const advert = advertWith(deviceA, {
      "topology/peers": {
        direct: [deviceB],
        relayed: [{ device: deviceC, via: deviceB }],
      },
    });
    expect(readTopologyPeers(advert)).toEqual({
      direct: [deviceB],
      relayed: [{ device: deviceC, via: deviceB }],
    });
  });
});

describe("assembleTopologyGraph", () => {
  it("lists every device in the directory as a node, even one with no topology of its own", () => {
    const directory: DirectoryEntry[] = [
      { device: deviceA, advert: advertWith(deviceA) },
    ];
    expect(assembleTopologyGraph(directory)).toEqual({
      nodes: [deviceA],
      edges: [],
    });
  });

  it("builds a direct edge per entry in a device's own reported direct peers", () => {
    const directory: DirectoryEntry[] = [
      {
        device: deviceA,
        advert: advertWith(deviceA, {
          "topology/peers": { direct: [deviceB], relayed: [] },
        }),
      },
    ];
    expect(assembleTopologyGraph(directory).edges).toEqual([
      { kind: "direct", from: deviceA, to: deviceB },
    ]);
  });

  it("builds a relay edge per relayed pairing, carrying the reported hub as `via`", () => {
    const directory: DirectoryEntry[] = [
      {
        device: deviceA,
        advert: advertWith(deviceA, {
          "topology/peers": {
            direct: [deviceB],
            relayed: [{ device: deviceC, via: deviceB }],
          },
        }),
      },
    ];
    expect(assembleTopologyGraph(directory).edges).toEqual([
      { kind: "direct", from: deviceA, to: deviceB },
      { kind: "relay", from: deviceA, to: deviceC, via: deviceB },
    ]);
  });

  it("keeps both sides' own reports as separate directed edges rather than merging them", () => {
    const directory: DirectoryEntry[] = [
      {
        device: deviceA,
        advert: advertWith(deviceA, {
          "topology/peers": { direct: [deviceB], relayed: [] },
        }),
      },
      {
        device: deviceB,
        advert: advertWith(deviceB, {
          "topology/peers": { direct: [deviceA], relayed: [] },
        }),
      },
    ];
    expect(assembleTopologyGraph(directory).edges).toEqual([
      { kind: "direct", from: deviceA, to: deviceB },
      { kind: "direct", from: deviceB, to: deviceA },
    ]);
  });

  it("skips a directory entry whose advert carries no topology, without dropping it from nodes", () => {
    const directory: DirectoryEntry[] = [
      { device: deviceA, advert: advertWith(deviceA) },
      {
        device: deviceB,
        advert: advertWith(deviceB, {
          "topology/peers": { direct: [deviceA], relayed: [] },
        }),
      },
    ];
    const graph = assembleTopologyGraph(directory);
    expect(graph.nodes).toEqual([deviceA, deviceB]);
    expect(graph.edges).toEqual([
      { kind: "direct", from: deviceB, to: deviceA },
    ]);
  });
});

describe("sendTopologyGet", () => {
  it("sends topology.get scoped to `node` and resolves with the parsed peers", async () => {
    const session = fakeSession();
    const peers = { direct: [deviceA], relayed: [] };
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "ok",
      peers,
    });

    const result = await sendTopologyGet(session);

    expect(result).toEqual(peers);
    const [command, scope, targetDevice, token, timeoutMs] = vi.mocked(
      session.sendManageRequest,
    ).mock.calls[0] as [
      ManageCommand,
      CapabilityScope,
      DeviceId | undefined,
      unknown,
      number | undefined,
    ];
    expect(command).toEqual(buildTopologyGetCommand());
    expect(scope).toEqual({ kind: "node" });
    expect(targetDevice).toBeUndefined();
    expect(token).toBeUndefined();
    expect(timeoutMs).toBeUndefined();
  });

  it("forwards targetDevice and timeoutMs to sendManageRequest", async () => {
    const session = fakeSession();
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "ok",
      peers: { direct: [], relayed: [] },
    });
    const TIMEOUT_MS = 5000;

    await sendTopologyGet(session, deviceA, TIMEOUT_MS);

    const [, , targetDevice, , timeoutMs] = vi.mocked(session.sendManageRequest)
      .mock.calls[0] as [
      unknown,
      unknown,
      DeviceId | undefined,
      unknown,
      number | undefined,
    ];
    expect(targetDevice).toEqual(deviceA);
    expect(timeoutMs).toBe(TIMEOUT_MS);
  });

  it("throws with the refusal code when the request is refused", async () => {
    const session = fakeSession();
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "error",
      code: "timeout",
    });

    await expect(sendTopologyGet(session)).rejects.toThrow(/timeout/);
  });

  it("throws when the response's own peers field is malformed", async () => {
    const session = fakeSession();
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "ok",
      peers: { direct: "not-an-array" },
    });

    await expect(sendTopologyGet(session)).rejects.toThrow(/malformed/);
  });
});

describe("createTopologyGetHandler", () => {
  it("answers with the session's own live topology", async () => {
    const session = fakeSession();
    const peers = { direct: [deviceA], relayed: [{ device: deviceB }] };
    vi.mocked(session.getTopologyPeers).mockReturnValue(peers);
    const handle = createTopologyGetHandler(session);
    const { incoming, respond } = fakeIncoming(buildTopologyGetCommand());

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({ result: "ok", peers });
  });

  it("refuses a request whose params do not match topology.get as malformed", async () => {
    const session = fakeSession();
    const handle = createTopologyGetHandler(session);
    const { incoming, respond } = fakeIncoming({
      verb: TOPOLOGY_GET_CAPABILITY,
      params: { verb: "not.topology.get" },
    });

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "malformed",
    });
    expect(session.getTopologyPeers).not.toHaveBeenCalled();
  });
});
