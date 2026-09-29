// The far end of a relay pairing, for tests that drive a MeshSession over a FakeConnection: a real identity that speaks the secure channel (spec/secure-channel.cddl) the way a peer reached through a hub does, so a test can deliver a frame "from" it and read what the session sent it without a hub in the middle.

import { tryDecodeFrame, wrapRelayData } from "../src/adapters/frame-codec.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import {
  beginHandshake,
  establishChannel,
  verifyHello,
  type SecureChannel,
} from "../src/domain/secure-channel.js";
import type {
  DeviceId,
  Frame,
  RelayDataFrame,
  SecureHelloFrame,
} from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { FakeConnection } from "./mesh-session-fixtures.js";

const POLL_INTERVAL_MS = 1;

async function sleep(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, POLL_INTERVAL_MS);
  });
}

function relayData(frame: Frame): RelayDataFrame | undefined {
  return frame.type === "relay-data" ? frame : undefined;
}

/** The nested frame a relay-data frame carries, when it was addressed to `device`. */
function nestedFor(frame: Frame, device: DeviceId): Frame | null {
  const wrapped = relayData(frame);
  const target = wrapped?.["to-device"];
  if (wrapped === undefined || target === undefined) return null;
  if (deviceIdToHex(target) !== deviceIdToHex(device)) return null;
  return tryDecodeFrame(wrapped.payload);
}

export class RelayPeer {
  private channel: SecureChannel | undefined;
  private consumed = 0;

  constructor(
    readonly identity: Readonly<IdentityPort>,
    private readonly session: Readonly<IdentityPort>,
    private readonly link: Readonly<FakeConnection>,
  ) {}

  get deviceId(): DeviceId {
    return this.identity.deviceId;
  }

  private hellosSent(): SecureHelloFrame[] {
    return this.link.sent.flatMap((sent) => {
      const inner = nestedFor(sent, this.deviceId);
      return inner?.type === "secure-hello" ? [inner] : [];
    });
  }

  /** The hello the session sent this peer after the first `skip`, waiting for it to appear. */
  private async sessionHello(skip = 0): Promise<SecureHelloFrame> {
    for (;;) {
      const hello = this.hellosSent()[skip];
      if (hello !== undefined) {
        return hello;
      }
      await sleep();
    }
  }

  private async complete(
    pending: Awaited<ReturnType<typeof beginHandshake>>,
    hello: SecureHelloFrame,
  ): Promise<void> {
    const verdict = await verifyHello(this.identity, hello);
    if (!verdict.ok) {
      throw new Error(`the session's hello was refused: ${verdict.reason}`);
    }
    this.channel = await establishChannel(
      this.identity,
      pending,
      hello,
      verdict.peer,
    );
    if (this.channel === undefined) {
      throw new Error("no channel could be established with the session");
    }
  }

  /** Answers the hello the session sent this peer, once it appears, and completes the channel. */
  async answerHello(): Promise<void> {
    const hello = await this.sessionHello();
    const pending = await beginHandshake(this.identity, this.session.deviceId);
    this.link.push({
      type: "relay-data",
      payload: new Uint8Array(wrapRelayData(pending.hello).payload),
      "from-device": this.deviceId,
    });
    await this.complete(pending, hello);
  }

  /** Speaks first: pairs with the session and sends it a hello, then completes the channel with the answer. */
  async openTowardSession(): Promise<void> {
    const alreadySent = this.hellosSent().length;
    this.link.push({ type: "relay-inbound", "source-device": this.deviceId });
    const pending = await beginHandshake(this.identity, this.session.deviceId);
    this.link.push({
      type: "relay-data",
      payload: new Uint8Array(wrapRelayData(pending.hello).payload),
      "from-device": this.deviceId,
    });
    await this.complete(pending, await this.sessionHello(alreadySent));
  }

  /** Delivers a frame from this peer to the session, sealed and stamped as the hub would forward it. */
  async deliver(
    frame: Frame,
    extra: Readonly<{ toDevice?: DeviceId; stampedFrom?: DeviceId }> = {},
  ): Promise<void> {
    if (this.channel === undefined) {
      throw new Error("open the channel first");
    }
    const sealed = await this.channel.seal(frame);
    this.link.push({
      ...wrapRelayData(sealed),
      "from-device": extra.stampedFrom ?? this.deviceId,
      ...(extra.toDevice !== undefined ? { "to-device": extra.toDevice } : {}),
    });
  }

  /** Every frame the session has sent this peer since the last call, opened, waiting until at least one has arrived. */
  async received(): Promise<Frame[]> {
    if (this.channel === undefined) {
      throw new Error("open the channel first");
    }
    for (;;) {
      const opened: Frame[] = [];
      const sealed = this.link.sent.flatMap((frame) => {
        const inner = nestedFor(frame, this.deviceId);
        return inner?.type === "secure-data" ? [inner] : [];
      });
      for (const data of sealed.slice(this.consumed)) {
        const inner = await this.channel.open(data);
        if (inner !== undefined) opened.push(inner);
      }
      if (opened.length > 0) {
        this.consumed = sealed.length;
        return opened;
      }
      await sleep();
    }
  }
}
