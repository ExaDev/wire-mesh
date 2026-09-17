#!/usr/bin/env node
// The wire-mesh-sfu CLI entrypoint: a standalone media-relay service accepting real MeshSessions over a WebSocket transport (reusing wire-mesh-node's own adapter, the identical wire protocol every deployment already speaks) and handing each one to a shared SfuCall. Deployment mode is a genuine, independent choice from the mediasoup backend itself (see spec/webrtc.cddl's own module header): this is the standalone-service half of that choice; an in-process deployment inside another wire-mesh-node process would call createSfuCall/createMediasoupMediaBackend directly instead of spawning this binary, sharing the identical domain and adapter code.
//
// Identity: this SFU signs its own handshake with a freshly generated, in-memory ES256 keypair each time it starts, never persisted to disk: a deliberate v1 scope choice, not an oversight. It matters for restart continuity (a restarted SFU cannot be recognised as "the same device" by anyone holding an old capability-token scoped to its old device-id) but not for correctness within one run: this SFU never issues its own capability tokens for others to hold long-term, and its own identity is used only to sign/verify handshake and manage-request exchanges for the lifetime of the process. A future revision wanting restart continuity would persist the keypair the same way core/node-fs-storage already persists other node-local state.

import { webcrypto } from "node:crypto";
import { createNodeIdentity } from "wire-mesh-core/adapters/node-identity";
import { acceptMeshSession } from "wire-mesh-core/domain/mesh-session";
import type { RevocationCheck } from "wire-mesh-core/domain/tokens";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createNodeWebSocketTransport } from "wire-mesh-node/adapters/node-websocket-transport";
import { createSfuCall } from "./domain/sfu-session.js";
import { createMediasoupMediaBackend } from "./adapters/mediasoup-media-backend.js";

const ES256 = -7;
const DEFAULT_BIND_ADDRESS = "0.0.0.0:8788";
const HTTP_OK = 200;
const LOCAL_DOMAINS = ["core/webrtc"];

export function healthResponse(): { ok: true; node: string; roles: string[] } {
  return { ok: true, node: "wire-mesh-sfu", roles: ["sfu"] };
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const flagIndex = argv.indexOf(flag);
  return flagIndex === -1 ? undefined : argv[flagIndex + 1];
}

export function bindAddressFromArgs(argv: readonly string[]): string {
  return argValue(argv, "--bind") ?? DEFAULT_BIND_ADDRESS;
}

export function listenIpFromArgs(argv: readonly string[]): string {
  return argValue(argv, "--listen-ip") ?? "0.0.0.0";
}

export function announcedIpFromArgs(
  argv: readonly string[],
): string | undefined {
  return argValue(argv, "--announced-ip");
}

/** No revocation-gossip ingestion yet: there is nowhere for a revocation-announce frame to land and be recorded. The identical explicit, deliberate limitation web-console's own noRevocationCheck documents: every otherwise-valid token is treated as unrevoked. */
const noRevocationCheck: RevocationCheck = {
  entriesFor: async () => Promise.resolve([]),
};

async function generateIdentity(): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return createNodeIdentity(keyPair.privateKey, publicKeyBytes, ES256);
}

// A genuine CLI startup message, not library logging: isolated in its own function so eslint.config.ts's no-console override can scope narrowly to this file rather than the whole package, matching wire-mesh-node's own identical pattern.
function logStartup(message: string): void {
  console.log(message);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const identity = await generateIdentity();
  const announcedIp = announcedIpFromArgs(argv);
  const backend = await createMediasoupMediaBackend({
    listenIp: listenIpFromArgs(argv),
    ...(announcedIp !== undefined ? { announcedIp } : {}),
  });
  const call = createSfuCall(backend, {
    identity,
    clock: { now: () => Date.now() },
    revocation: noRevocationCheck,
  });
  const transport = createNodeWebSocketTransport({
    onHttpRequest: (_request, response) => {
      response.writeHead(HTTP_OK, { "content-type": "application/json" });
      response.end(JSON.stringify(healthResponse()));
    },
  });
  const listener = await transport.listen(
    bindAddressFromArgs(argv),
    (connection) => {
      void (async () => {
        const session = await acceptMeshSession(
          connection,
          identity,
          LOCAL_DOMAINS,
        );
        const deviceId = await session.peerDeviceId;
        await call.addParticipant(deviceId, session);
        await call.removeParticipant(deviceId);
      })();
    },
  );
  logStartup(`wire-mesh-sfu listening on ${listener.address}`);
}

// Only run as a side effect when executed directly (the CLI bin entry): never on a plain import, matching wire-mesh-node/src/server.ts's own guard, which is how a future test suite would reach healthResponse()/bindAddressFromArgs() without binding a real port.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === `file://${invokedPath}`) {
  void main();
}
