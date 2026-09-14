import { describe, expect, it, vi } from "vitest";
import { deviceIdFromHex } from "../src/domain/device-id.js";
import type {
  DirectoryEntry,
  MeshSession,
} from "../src/domain/mesh-session.js";
import type { CapabilityScope, PeerAdvert } from "../src/generated/protocol.js";
import {
  advertiseGrantCandidates,
  findGrantCandidate,
  type GrantCandidate,
} from "../src/domain/grant-candidates.js";

const ROOM_SCOPE: CapabilityScope = { kind: "room", path: "team/general" };
const ROOM_MEMBER = "room:member";

const DEVICE_ID_HEX_LENGTH = 64; // 32 bytes, hex-encoded -- matches device-id.ts's own DEVICE_ID_HEX_LENGTH
const DEVICE_A = deviceIdFromHex("a".repeat(DEVICE_ID_HEX_LENGTH));
const DEVICE_B = deviceIdFromHex("b".repeat(DEVICE_ID_HEX_LENGTH));

function advertWith(extensions: Record<string, unknown>): PeerAdvert {
  return {
    device: DEVICE_A,
    addresses: [],
    "snapshot-seconds": 0,
    ...extensions,
  };
}

function entry(device = DEVICE_A, advert: PeerAdvert): DirectoryEntry {
  return { device, advert };
}

describe("advertiseGrantCandidates", () => {
  it("gossips the candidate list under the domain-qualified capability-request/candidates key", async () => {
    const sendGossipUpdate = vi.fn(async (): Promise<void> =>
      Promise.resolve(),
    );
    const session = { sendGossipUpdate } as unknown as MeshSession;
    const candidates: readonly GrantCandidate[] = [
      {
        capability: ROOM_MEMBER,
        scope: ROOM_SCOPE,
        "delegations-remaining": 2,
      },
    ];

    await advertiseGrantCandidates(session, candidates);

    expect(sendGossipUpdate).toHaveBeenCalledWith({
      "capability-request/candidates": candidates,
    });
  });
});

describe("findGrantCandidate", () => {
  it("returns undefined when the directory is empty", () => {
    expect(findGrantCandidate([], ROOM_MEMBER, ROOM_SCOPE)).toBeUndefined();
  });

  it("returns undefined when no peer has advertised any candidates", () => {
    const directory = [entry(DEVICE_A, advertWith({}))];
    expect(
      findGrantCandidate(directory, ROOM_MEMBER, ROOM_SCOPE),
    ).toBeUndefined();
  });

  it("returns the device-id of a peer advertising a qualifying candidate", () => {
    const directory = [
      entry(
        DEVICE_A,
        advertWith({
          "capability-request/candidates": [
            { capability: ROOM_MEMBER, scope: ROOM_SCOPE },
          ],
        }),
      ),
    ];
    expect(findGrantCandidate(directory, ROOM_MEMBER, ROOM_SCOPE)).toEqual(
      DEVICE_A,
    );
  });

  it("matches a candidate whose advertised scope is a broader ancestor of the requested scope", () => {
    const directory = [
      entry(
        DEVICE_A,
        advertWith({
          "capability-request/candidates": [
            {
              capability: "folder:read",
              scope: { kind: "folder", path: "/work" },
            },
          ],
        }),
      ),
    ];
    const narrowerScope: CapabilityScope = {
      kind: "folder",
      path: "/work/sub",
    };
    expect(findGrantCandidate(directory, "folder:read", narrowerScope)).toEqual(
      DEVICE_A,
    );
  });

  it("skips a candidate advertising a different capability", () => {
    const directory = [
      entry(
        DEVICE_A,
        advertWith({
          "capability-request/candidates": [
            { capability: "exec:pty", scope: ROOM_SCOPE },
          ],
        }),
      ),
    ];
    expect(
      findGrantCandidate(directory, ROOM_MEMBER, ROOM_SCOPE),
    ).toBeUndefined();
  });

  it("skips a candidate whose advertised scope does not narrow into the requested scope", () => {
    const directory = [
      entry(
        DEVICE_A,
        advertWith({
          "capability-request/candidates": [
            {
              capability: "folder:read",
              scope: { kind: "folder", path: "/other" },
            },
          ],
        }),
      ),
    ];
    const requestedScope: CapabilityScope = { kind: "folder", path: "/work" };
    expect(
      findGrantCandidate(directory, "folder:read", requestedScope),
    ).toBeUndefined();
  });

  it("skips a candidate whose delegations-remaining has reached zero", () => {
    const directory = [
      entry(
        DEVICE_A,
        advertWith({
          "capability-request/candidates": [
            {
              capability: ROOM_MEMBER,
              scope: ROOM_SCOPE,
              "delegations-remaining": 0,
            },
          ],
        }),
      ),
    ];
    expect(
      findGrantCandidate(directory, ROOM_MEMBER, ROOM_SCOPE),
    ).toBeUndefined();
  });

  it("accepts a candidate with no delegations-remaining field as unbounded", () => {
    const directory = [
      entry(
        DEVICE_A,
        advertWith({
          "capability-request/candidates": [
            { capability: ROOM_MEMBER, scope: ROOM_SCOPE },
          ],
        }),
      ),
    ];
    expect(findGrantCandidate(directory, ROOM_MEMBER, ROOM_SCOPE)).toEqual(
      DEVICE_A,
    );
  });

  it("returns the first qualifying candidate in directory order when several qualify", () => {
    const directory = [
      entry(
        DEVICE_A,
        advertWith({
          "capability-request/candidates": [
            { capability: ROOM_MEMBER, scope: ROOM_SCOPE },
          ],
        }),
      ),
      {
        device: DEVICE_B,
        advert: {
          device: DEVICE_B,
          addresses: [],
          "snapshot-seconds": 0,
          "capability-request/candidates": [
            { capability: ROOM_MEMBER, scope: ROOM_SCOPE },
          ],
        },
      },
    ];
    expect(findGrantCandidate(directory, ROOM_MEMBER, ROOM_SCOPE)).toEqual(
      DEVICE_A,
    );
  });

  it("ignores a malformed (non-array) candidates value rather than throwing", () => {
    const directory = [
      entry(
        DEVICE_A,
        advertWith({ "capability-request/candidates": "not an array" }),
      ),
    ];
    expect(
      findGrantCandidate(directory, ROOM_MEMBER, ROOM_SCOPE),
    ).toBeUndefined();
  });

  it("ignores a candidate entry that doesn't match the schema rather than throwing", () => {
    const directory = [
      entry(
        DEVICE_A,
        advertWith({
          "capability-request/candidates": [{ notEvenClose: true }],
        }),
      ),
    ];
    expect(
      findGrantCandidate(directory, ROOM_MEMBER, ROOM_SCOPE),
    ).toBeUndefined();
  });
});
