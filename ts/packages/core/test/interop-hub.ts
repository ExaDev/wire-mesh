// An in-memory relay hub between MeshSessions, each over a FakeConnection, for tests that run two different builds of the session against each other. It carries relay-connect as relay-inbound and relay-data to the device named, remembers every hello each device sent so a test can replay one, and adds nothing else. A device that restarts attaches its new connection under the same device-id.

import { tryDecodeFrame } from "../src/adapters/frame-codec.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import type { DeviceId, Frame } from "../src/generated/protocol.js";
import type { FakeConnection } from "./mesh-session-fixtures.js";

export class InteropHub {
  private readonly attached = new Map<string, FakeConnection>();

  private readonly hellos = new Map<string, Frame[]>();

  /** Connects `connection` as device `id`, replacing any connection that device had before. */
  attach(id: DeviceId, connection: FakeConnection): void {
    const from = deviceIdToHex(id);
    this.attached.set(from, connection);
    connection.tap((frame) => {
      if (this.attached.get(from) !== connection) {
        return;
      }
      if (frame.type === "relay-connect") {
        this.attached
          .get(deviceIdToHex(frame["target-device"]))
          ?.push({ type: "relay-inbound", "source-device": id });
      } else if (
        frame.type === "relay-data" &&
        frame["to-device"] !== undefined
      ) {
        const delivered: Frame = {
          type: "relay-data",
          payload: frame.payload,
          "from-device": id,
        };
        if (tryDecodeFrame(frame.payload)?.type === "secure-hello") {
          this.hellos.set(from, [...(this.hellos.get(from) ?? []), delivered]);
        }
        this.attached.get(deviceIdToHex(frame["to-device"]))?.push(delivered);
      }
    });
  }

  /** The hellos device `id` has sent through the hub, as delivered, in order. */
  helloFrom(id: DeviceId): readonly Frame[] {
    return this.hellos.get(deviceIdToHex(id)) ?? [];
  }

  /** Delivers `frame` to device `id` again. */
  replayTo(id: DeviceId, frame: Frame): void {
    this.attached.get(deviceIdToHex(id))?.push(frame);
  }
}
