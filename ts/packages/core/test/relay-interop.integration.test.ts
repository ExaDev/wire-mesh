/* The Rust relay client against the TypeScript hub and TypeScript peers, over the length-prefixed TCP framing both sides speak (`createTcpTransport` here, `TcpTransport` in Rust). The Rust side is the `relay_peer` example of wire-mesh-core, started as a child process; the hub is the real `createRelayHub`, observed and, where a case needs it, made hostile; the far end is a real MeshSession or a raw peer that speaks the secure channel by hand so it can send what a session never would (a plaintext request, a frame a channel may not carry, an answer from the wrong device).

   One case per rule the Rust client takes over: a pairing per target, a hello completed only with the sender the hub stamped, only a manage-request, a manage-response and core/data frames acted on, plaintext in relay-data dropped, an answer accepted only from the device the request went to, and a timeout forgetting the pairing. Each fails when its rule is removed from the Rust client (the mutations are recorded with the pull request that adds this file).

   This test builds and runs the Rust example, so it needs `cargo`. It is skipped, with the reason printed, only on a machine without it and outside CI; when `CI` is set a missing `cargo` is a failure, so the job that runs it cannot pass without running it. */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  messageFromFrame,
  tryDecodeFrame,
} from "../src/adapters/frame-codec.js";
import {
  deriveDeviceId,
  verifyWithPublicKey,
} from "../src/adapters/node-identity.js";
import { createTcpTransport } from "../src/adapters/tcp-transport.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import { createMeshSession } from "../src/domain/mesh-session.js";
import { signPeerAdvert } from "../src/domain/peer-advert.js";
import { createRelayHub } from "../src/domain/relay-hub.js";
import {
  beginHandshake,
  establishChannel,
  verifyHello,
  type SecureChannel,
} from "../src/domain/secure-channel.js";
import type {
  DeviceId,
  Frame,
  ManageCommand,
  SecureHelloFrame,
} from "../src/generated/protocol.js";
import type { Connection } from "../src/ports/transport.js";
import { bytesFromHex } from "./hex.js";
import { generateEd25519Identity } from "./tokens-fixtures.js";

const RUST_DIR = fileURLToPath(new URL("../../../../rust", import.meta.url));
const BUILD_TIMEOUT_MS = 900_000;
const CASE_TIMEOUT_MS = 60_000;
const POLL_MS = 20;
const SETTLE_MS = 400;
const REGISTER_MS = 300;
const REQUEST_TIMEOUT_MS = 5_000;
const SHORT_TIMEOUT_MS = 700;
const MS_PER_SECOND = 1_000;
const FLIP_MASK = 0xff;
const LATER_REQUEST_ID = 3;

const hasCargo = spawnSync("cargo", ["--version"]).status === 0;
if (!hasCargo && (process.env.CI ?? "") !== "") {
  throw new Error(
    "CI is set and cargo is not on the path: the Rust relay client cannot be run against the hub",
  );
}
const describeRust = hasCargo ? describe : describe.skip;

/** What a case sees of the hub: every frame each connection sent it, in order. */
interface Observed {
  readonly frames: { from: string; frame: Frame }[];
}

interface HubOptions {
  /** Rewrites a frame on its way from the hub to a connection: a hostile hub. */
  readonly towardConnection?: (frame: Frame) => Frame;
  /** Rewrites a frame on its way into the hub. */
  readonly intoHub?: (frame: Frame) => Frame;
}

async function startHub(options: HubOptions = {}): Promise<{
  address: string;
  observed: Observed;
  close: () => Promise<void>;
}> {
  const observed: Observed = { frames: [] };
  const hub = createRelayHub({
    identity: { verify: verifyWithPublicKey, deriveDeviceId },
  });
  let nextConnection = 0;
  const listener = await createTcpTransport().listen(
    "127.0.0.1:0",
    (connection) => {
      nextConnection += 1;
      const label = `connection-${String(nextConnection)}`;
      const watched: Connection = {
        ...connection,
        send: async (frame) =>
          connection.send(options.towardConnection?.(frame) ?? frame),
        receive: async function* () {
          for await (const frame of connection.receive()) {
            observed.frames.push({ from: label, frame });
            yield options.intoHub?.(frame) ?? frame;
          }
        },
      };
      void hub.handleConnection(watched);
    },
  );

  return {
    address: listener.address,
    observed,
    close: async () => {
      await listener.close();
    },
  };
}

/** Where the built example is, set once by the build before any case runs: the cases start this binary directly, so stopping a case stops the example itself and a case does not pay for cargo. */
let exampleBinary = "";

/** The Rust example, started and read line by line. */
class RustPeer {
  private readonly child: ChildProcess;

  readonly lines: string[] = [];

  constructor(args: readonly string[]) {
    this.child = spawn(exampleBinary, [...args], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    if (this.child.stdout === null) {
      throw new Error("the Rust peer has no standard output");
    }
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.lines.push(line);
    });
  }

  async line(prefix: string, skip = 0): Promise<string> {
    return vi.waitFor(
      () => {
        const held = this.lines.filter((line) => line.startsWith(prefix))[skip];
        if (held === undefined) {
          throw new Error(
            `the Rust peer printed no ${prefix} line: ${this.lines.join(" | ")}`,
          );
        }

        return held.slice(prefix.length).trim();
      },
      { interval: POLL_MS, timeout: CASE_TIMEOUT_MS },
    );
  }

  count(prefix: string): number {
    return this.lines.filter((line) => line.startsWith(prefix)).length;
  }

  async device(): Promise<DeviceId> {
    return bytesFromHex(await this.line("DEVICE "));
  }

  stop(): void {
    this.child.stdin?.end();
    this.child.kill();
  }
}

/** A peer that speaks the secure channel by hand over a real connection, so a case can send what a session never would. */
class RawPeer {
  channel: SecureChannel | undefined;

  private readonly taken = new Set<Frame>();

  private constructor(
    readonly identity: Awaited<ReturnType<typeof generateEd25519Identity>>,
    readonly connection: Connection,
    readonly received: readonly Frame[],
  ) {}

  static async join(address: string): Promise<RawPeer> {
    const identity = await generateEd25519Identity();
    const connection = await createTcpTransport().connect(address);
    const received: Frame[] = [];
    void (async () => {
      for await (const frame of connection.receive()) {
        received.push(frame);
      }
    })();
    const peer = new RawPeer(identity, connection, received);
    const advert = await signPeerAdvert(identity, {
      device: identity.deviceId,
      addresses: [],
      "snapshot-seconds": Math.floor(Date.now() / MS_PER_SECOND),
      "identity-key": identity.identityKey,
    });
    await connection.send({ type: "gossip", peers: [advert] });

    return peer;
  }

  get device(): DeviceId {
    return this.identity.deviceId;
  }

  async relay(frame: Frame, to: DeviceId): Promise<void> {
    await this.connection.send({
      type: "relay-data",
      payload: new Uint8Array(messageFromFrame(frame)),
      "to-device": to,
    });
  }

  /** Pairs with `target` and completes a secure channel with it: sends a hello and opens the target's answer. */
  async openChannelTo(target: DeviceId): Promise<void> {
    await this.connection.send({
      type: "relay-connect",
      "target-device": target,
    });
    const pending = await beginHandshake(this.identity, target);
    await this.relay(pending.hello, target);
    await this.complete(pending, await this.nextHello());
  }

  /** Waits for the target's hello (it dialled this peer first), answers it and completes the channel. */
  async answerChannelFrom(target: DeviceId): Promise<void> {
    const hello = await this.nextHello();
    const pending = await beginHandshake(this.identity, target);
    await this.relay(pending.hello, target);
    await this.complete(pending, hello);
  }

  private async complete(
    pending: Awaited<ReturnType<typeof beginHandshake>>,
    hello: SecureHelloFrame,
  ): Promise<void> {
    const verdict = await verifyHello(this.identity, hello);
    if (!verdict.ok) {
      throw new Error(`the target's hello was refused: ${verdict.reason}`);
    }
    this.channel = await establishChannel(
      this.identity,
      pending,
      hello,
      verdict.peer,
    );
  }

  private async nextHello(): Promise<SecureHelloFrame> {
    return vi.waitFor(
      () => {
        for (const frame of this.received) {
          if (frame.type !== "relay-data" || this.taken.has(frame)) continue;
          const inner = tryDecodeFrame(frame.payload);
          if (inner?.type === "secure-hello") {
            this.taken.add(frame);

            return inner;
          }
        }
        throw new Error("no hello has arrived");
      },
      { interval: POLL_MS, timeout: CASE_TIMEOUT_MS },
    );
  }

  async sealTo(frame: Frame, to: DeviceId): Promise<void> {
    if (this.channel === undefined) {
      throw new Error("open the channel first");
    }
    await this.relay(await this.channel.seal(frame), to);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const echo: ManageCommand = {
  verb: "relay:echo",
  params: { verb: "relay:echo" },
};

function manageRequest(requestId: number): Frame {
  return {
    type: "manage-request",
    "request-id": requestId,
    command: echo,
    scope: { kind: "folder" },
  };
}

function manageResponse(requestId: number): Frame {
  return {
    type: "manage-response",
    "request-id": requestId,
    outcome: { result: "ok" },
  };
}

/** A real MeshSession answering every request it receives. */
async function answeringSession(hub: {
  address: string;
  observed: Observed;
}): Promise<{
  device: DeviceId;
  requests: () => number;
  close: () => Promise<void>;
}> {
  const identity = await generateEd25519Identity();
  const session = createMeshSession(createTcpTransport(), identity);
  const announced = hub.observed.frames.filter(
    (entry) => entry.frame.type === "gossip",
  ).length;
  await session.connect(hub.address, ["core/management"]);
  let seen = 0;
  void (async () => {
    for await (const request of session.incomingManageRequests) {
      seen += 1;
      await request.respond({ result: "ok" });
    }
  })();
  await announcedAt(hub, announced + 1);

  return {
    device: identity.deviceId,
    requests: () => seen,
    close: async () => session.close(),
  };
}

/** Waits until the hub has received `count` announcements, then a moment for it to have registered them: a hub routes only to devices it has registered. */
async function announcedAt(
  hub: { observed: Observed },
  count: number,
): Promise<void> {
  await vi.waitFor(
    () => {
      const seen = hub.observed.frames.filter(
        (entry) => entry.frame.type === "gossip",
      ).length;
      if (seen < count) {
        throw new Error(
          `the hub has seen ${String(seen)} of ${String(count)} announcements`,
        );
      }
    },
    { interval: POLL_MS, timeout: CASE_TIMEOUT_MS },
  );
  await wait(REGISTER_MS);
}

function relayConnects(observed: Observed, label?: string): number {
  return observed.frames.filter(
    (entry) =>
      entry.frame.type === "relay-connect" &&
      (label === undefined || entry.from === label),
  ).length;
}

describeRust("the Rust relay client against the TypeScript hub", () => {
  beforeAll(() => {
    // One build for every case. `--message-format=json` names the executable cargo produced, wherever the target directory is.
    const built = spawnSync(
      "cargo",
      [
        "build",
        "--quiet",
        "--locked",
        "-p",
        "wire-mesh-core",
        "--example",
        "relay_peer",
        "--message-format=json-render-diagnostics",
      ],
      { cwd: RUST_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    if (built.status !== 0) {
      throw new Error("the relay_peer example did not build");
    }
    const artefact = built.stdout
      .split("\n")
      .flatMap((line) => {
        try {
          const message: unknown = JSON.parse(line);
          if (
            typeof message === "object" &&
            message !== null &&
            "executable" in message &&
            typeof message.executable === "string" &&
            "target" in message &&
            typeof message.target === "object" &&
            message.target !== null &&
            "name" in message.target &&
            message.target.name === "relay_peer"
          ) {
            return [message.executable];
          }
        } catch {
          // A line that is not JSON is not an artefact message.
        }

        return [];
      })
      .at(-1);
    if (artefact === undefined) {
      throw new Error("cargo did not name the relay_peer executable");
    }
    exampleBinary = artefact;
  }, BUILD_TIMEOUT_MS);

  it(
    "gets requests to a TypeScript session answered, with one relay-connect per target and only hellos and ciphertext at the hub",
    async () => {
      const hub = await startHub();
      const far = await answeringSession(hub);
      const rust = new RustPeer([
        hub.address,
        "request",
        deviceIdToHex(far.device),
        "2",
        String(REQUEST_TIMEOUT_MS),
      ]);
      try {
        expect(await rust.line("RESULT ")).toBe("ok");
        expect(await rust.line("RESULT ", 1)).toBe("ok");
        expect(far.requests()).toBe(2);
        expect(relayConnects(hub.observed)).toBe(1);
        const relayed = hub.observed.frames.flatMap((entry) =>
          entry.frame.type === "relay-data" ? [entry.frame] : [],
        );
        expect(relayed.length).toBeGreaterThan(0);
        for (const frame of relayed) {
          expect(["secure-hello", "secure-data"]).toContain(
            tryDecodeFrame(frame.payload)?.type,
          );
          expect(new TextDecoder("latin1").decode(frame.payload)).not.toContain(
            "relay:echo",
          );
        }
      } finally {
        rust.stop();
        await far.close();
        await hub.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "gets nothing through a hub that alters the sealed data it carries",
    async () => {
      const hub = await startHub({
        intoHub: (frame) => {
          if (frame.type !== "relay-data") return frame;
          const inner = tryDecodeFrame(frame.payload);
          if (inner?.type !== "secure-data") return frame;
          const ciphertext = Uint8Array.from(inner.ciphertext);
          ciphertext[0] = (ciphertext[0] ?? 0) ^ FLIP_MASK;

          return {
            ...frame,
            payload: new Uint8Array(messageFromFrame({ ...inner, ciphertext })),
          };
        },
      });
      const far = await answeringSession(hub);
      const rust = new RustPeer([
        hub.address,
        "request",
        deviceIdToHex(far.device),
        "1",
        String(SHORT_TIMEOUT_MS),
      ]);
      try {
        expect(await rust.line("RESULT ")).toBe("timeout");
        expect(far.requests()).toBe(0);
      } finally {
        rust.stop();
        await far.close();
        await hub.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "completes no channel with a hello the hub stamped as another device",
    async () => {
      const other = await generateEd25519Identity();
      const hub = await startHub({
        towardConnection: (frame) =>
          frame.type === "relay-data"
            ? { ...frame, "from-device": other.deviceId }
            : frame,
      });
      const far = await answeringSession(hub);
      const rust = new RustPeer([
        hub.address,
        "request",
        deviceIdToHex(far.device),
        "1",
        String(SHORT_TIMEOUT_MS),
      ]);
      try {
        expect(await rust.line("RESULT ")).toBe("timeout");
        expect(far.requests()).toBe(0);
      } finally {
        rust.stop();
        await far.close();
        await hub.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "forgets the pairing when a request times out, so the next request pairs afresh",
    async () => {
      const hub = await startHub();
      const silent = await RawPeer.join(hub.address);
      await announcedAt(hub, 1);
      const rust = new RustPeer([
        hub.address,
        "request",
        deviceIdToHex(silent.device),
        "2",
        String(SHORT_TIMEOUT_MS),
      ]);
      try {
        expect(await rust.line("RESULT ", 1)).toBe("timeout");
        // Each request paired on its own: the first timed out, the pairing and channel were forgotten, and the second paired afresh.
        expect(relayConnects(hub.observed, "connection-2")).toBe(2);
      } finally {
        rust.stop();
        await silent.close();
        await hub.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  describe("a Rust node serving requests", () => {
    async function serving(): Promise<{
      hub: Awaited<ReturnType<typeof startHub>>;
      rust: RustPeer;
      peer: RawPeer;
      rustDevice: DeviceId;
    }> {
      const hub = await startHub();
      const rust = new RustPeer([hub.address, "serve"]);
      const rustDevice = await rust.device();
      await rust.line("ANNOUNCED");
      await announcedAt(hub, 1);
      const peer = await RawPeer.join(hub.address);
      await announcedAt(hub, 2);

      return { hub, rust, peer, rustDevice };
    }

    it(
      "drops a manage-request sent in the clear inside relay-data, and answers the same request sealed",
      async () => {
        const { hub, rust, peer, rustDevice } = await serving();
        try {
          await peer.connection.send({
            type: "relay-connect",
            "target-device": rustDevice,
          });
          await peer.relay(manageRequest(1), rustDevice);
          await wait(SETTLE_MS);
          expect(rust.count("HANDLED")).toBe(0);
          await peer.openChannelTo(rustDevice);
          await peer.sealTo(manageRequest(2), rustDevice);
          await rust.line("HANDLED ");
          expect(rust.count("HANDLED")).toBe(1);
        } finally {
          rust.stop();
          await peer.close();
          await hub.close();
        }
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "acts only on a manage-request, a manage-response or a core/data frame that opened under a channel",
      async () => {
        const { hub, rust, peer, rustDevice } = await serving();
        try {
          await peer.openChannelTo(rustDevice);
          await peer.sealTo({ type: "ping" }, rustDevice);
          await peer.sealTo({ type: "pong" }, rustDevice);
          await wait(SETTLE_MS);
          expect(rust.count("HANDLED")).toBe(0);
          expect(rust.count("DATA")).toBe(0);
          await peer.sealTo(
            { type: "data-have", peer: peer.device, "head-seq": 1 },
            rustDevice,
          );
          expect(await rust.line("DATA ")).toBe(deviceIdToHex(peer.device));
          await peer.sealTo(manageRequest(LATER_REQUEST_ID), rustDevice);
          await rust.line("HANDLED ");
        } finally {
          rust.stop();
          await peer.close();
          await hub.close();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  it(
    "accepts an answer only from the device the request went to",
    async () => {
      const hub = await startHub();
      const target = await RawPeer.join(hub.address);
      const bystander = await RawPeer.join(hub.address);
      await announcedAt(hub, 2);
      const rust = new RustPeer([
        hub.address,
        "request",
        deviceIdToHex(target.device),
        "1",
        String(REQUEST_TIMEOUT_MS),
      ]);
      try {
        const rustDevice = await rust.device();
        await target.answerChannelFrom(rustDevice);
        // The bystander holds a channel with the Rust node of its own and answers the request-id the target was asked: that must not resolve it.
        await bystander.openChannelTo(rustDevice);
        await bystander.sealTo(manageResponse(0), rustDevice);
        await wait(SETTLE_MS);
        expect(rust.count("RESULT")).toBe(0);
        await target.sealTo(manageResponse(0), rustDevice);
        expect(await rust.line("RESULT ")).toBe("ok");
      } finally {
        rust.stop();
        await target.close();
        await bystander.close();
        await hub.close();
      }
    },
    CASE_TIMEOUT_MS,
  );
});
