import { describe, expect, it, vi } from "vitest";
import { createMeshSession } from "../src/domain/mesh-session.js";
import type { Connection, Transport } from "../src/ports/transport.js";
import {
  FakeConnection,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";

const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1;
const FIRST_ADDRESS = "ws://node-a";
const LEARNED_ADDRESS = "ws://node-b";

describe("redialAddress", () => {
  it("dials the address a connection says reaches its peer now, not the one it was first dialled with", async () => {
    const dialled: string[] = [];
    const fakes: FakeConnection[] = [];
    const transport: Transport = {
      connect: async (address): Promise<Connection> => {
        dialled.push(address);
        const fake = new FakeConnection();
        fakes.push(fake);
        // Only the first connection has learned a newer address; the second is dialled with it and learns nothing more.
        return Promise.resolve(
          dialled.length === 1
            ? { ...fake.connection, redialAddress: () => LEARNED_ADDRESS }
            : fake.connection,
        );
      },
      listen: async () => Promise.reject(new Error("client-only transport")),
    };
    const session = createMeshSession(transport, testIdentity, testClock, {
      maxAttempts: RECONNECT_ATTEMPTS,
      delayMs: () => RECONNECT_DELAY_MS,
    });
    await session.connect(FIRST_ADDRESS, ["core/management"]);
    fakes[0]?.fail(new Error("dropped"));
    await vi.waitFor(() => {
      expect(dialled).toHaveLength(2);
    });
    expect(dialled).toEqual([FIRST_ADDRESS, LEARNED_ADDRESS]);
    await session.close();
  });

  it("keeps dialling the original address when the connection learned nothing", async () => {
    const dialled: string[] = [];
    const fakes: FakeConnection[] = [];
    const transport: Transport = {
      connect: async (address): Promise<Connection> => {
        dialled.push(address);
        const fake = new FakeConnection();
        fakes.push(fake);
        return Promise.resolve(fake.connection);
      },
      listen: async () => Promise.reject(new Error("client-only transport")),
    };
    const session = createMeshSession(transport, testIdentity, testClock, {
      maxAttempts: RECONNECT_ATTEMPTS,
      delayMs: () => RECONNECT_DELAY_MS,
    });
    await session.connect(FIRST_ADDRESS, ["core/management"]);
    fakes[0]?.fail(new Error("dropped"));
    await vi.waitFor(() => {
      expect(dialled).toHaveLength(2);
    });
    expect(dialled).toEqual([FIRST_ADDRESS, FIRST_ADDRESS]);
    await session.close();
  });
});
