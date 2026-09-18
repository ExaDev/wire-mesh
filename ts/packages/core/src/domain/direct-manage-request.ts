// One-off manage-request/manage-response over a fresh, bare connection: no handshake, no negotiation, no gossip, no session left behind afterwards. A distinct concern from mesh-session.ts's own stateful MeshSession -- these functions share no closure state with createSessionCore, only the IncomingManageRequest/ManageOutcome types every manage-request path answers with (mesh-session.ts's own exports, imported below rather than redefined here).

import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  ManageCommand,
  ManageRequestFrame,
  ManageResponseFrame,
} from "../generated/protocol.js";
import { deviceIdToHex } from "./device-id.js";
import type { Connection, Transport } from "../ports/transport.js";
import type { IncomingManageRequest, ManageOutcome } from "./mesh-session.js";

/** Reads exactly one frame off a freshly-accepted, bare connection and, if it's a manage-request, returns an IncomingManageRequest ready to hand to the same application-level dispatch logic session.incomingManageRequests already feeds elsewhere -- no handshake or gossip is ever read or sent on this connection (wire-mesh#38: the manage-request/manage-response exchange has no dependency on handshake state at the dispatch layer, confirmed against mesh-session.ts's own applyManageRequest/applyFrame). respond() sends the manage-response directly and closes the connection, since a one-off request/response is this connection's entire purpose -- unlike a real MeshSession, there is nothing further to do with it afterwards. Resolves null, without closing the connection (that's the caller's call), for any other first frame or if the connection ends before one arrives: interpreting either case is a Transport.listen() caller's own business, e.g. peeking the first frame to route between this path and acceptMeshSession's own handshake path. */
export async function acceptDirectManageRequest(
  connection: Readonly<Connection>,
): Promise<IncomingManageRequest | null> {
  const iterator = connection.receive()[Symbol.asyncIterator]();
  const result = await iterator.next();
  if (result.done === true || result.value.type !== "manage-request") {
    return null;
  }
  const frame = result.value;
  return {
    requestId: frame["request-id"],
    command: frame.command,
    scope: frame.scope,
    ...(frame.token !== undefined ? { token: frame.token } : {}),
    respond: async (outcome: ManageOutcome): Promise<void> => {
      const response: ManageResponseFrame = {
        type: "manage-response",
        "request-id": frame["request-id"],
        outcome,
      };
      await connection.send(response);
      await connection.close();
    },
  };
}

async function waitForDirectManageResponse(
  link: Readonly<Connection>,
  requestId: number,
): Promise<ManageOutcome> {
  for await (const frame of link.receive()) {
    if (frame.type === "manage-response" && frame["request-id"] === requestId) {
      return frame.outcome;
    }
  }
  throw new Error("connection closed before a response arrived");
}

export interface DirectManageRequestOptions {
  /** Refuse the connection as a possible spoofing attempt if the transport's own authenticated Connection.peerDeviceId (never a value read off the wire -- see the Transport port's own doc comment) doesn't match this. Left unchecked when the transport gives no authenticated peerDeviceId at all (an unauthenticated transport, or a peer that presented no credential) -- the caller proceeds at its own risk in that case, exactly the same trust boundary Connection.peerDeviceId already documents for every other consumer of it. */
  expectedPeerDeviceId?: DeviceId;
  token?: CapabilityToken;
  /** Omit to wait indefinitely, matching sendManageRequest's own default. */
  timeoutMs?: number;
}

/** Sends exactly one manage-request over a fresh, bare connection with no handshake, negotiation, or gossip exchanged, and no session left behind afterwards -- the connection closes once the correlated response arrives, the wait times out, or the peer-device-id check below refuses it. For attempting a direct connection to a peer whose reachable address is already known (wire-mesh#38), as an alternative to routing the same request through a relay via an established MeshSession's own sendManageRequest(targetDevice, ...). Resolves the same ManageOutcome shape sendManageRequest does -- including `{ result: "error", code: "timeout" }` on a timeout, never a rejection -- so a caller can fall back to the relay path uniformly regardless of which kind of failure this returns for the non-spoofing cases; a peer-device-id mismatch is the one case that rejects outright, since it is not an ordinary reachability failure a relay fallback should silently paper over. */
export async function sendDirectManageRequest(
  transport: Readonly<Pick<Transport, "connect">>,
  address: string,
  command: ManageCommand,
  scope: Readonly<CapabilityScope>,
  options: Readonly<DirectManageRequestOptions> = {},
): Promise<ManageOutcome> {
  const link = await transport.connect(address);
  if (
    options.expectedPeerDeviceId !== undefined &&
    link.peerDeviceId !== undefined &&
    deviceIdToHex(link.peerDeviceId) !==
      deviceIdToHex(options.expectedPeerDeviceId)
  ) {
    await link.close();
    throw new Error(
      "direct connection's authenticated peer-device-id does not match the expected target -- refusing as a possible spoofing attempt",
    );
  }
  const requestId = 0;
  const frame: ManageRequestFrame = {
    type: "manage-request",
    "request-id": requestId,
    command,
    scope,
    ...(options.token !== undefined ? { token: options.token } : {}),
  };
  await link.send(frame);
  const responsePromise = waitForDirectManageResponse(link, requestId);
  let outcome: ManageOutcome;
  if (options.timeoutMs === undefined) {
    outcome = await responsePromise;
  } else {
    outcome = await Promise.race([
      responsePromise,
      new Promise<ManageOutcome>((resolve) => {
        setTimeout(() => {
          resolve({ result: "error", code: "timeout" });
        }, options.timeoutMs);
      }),
    ]);
    // Closing below ends the losing branch's own receive() iteration, which then throws -- caught here so that rejection is never left unhandled once this function has already settled via the timeout branch.
    responsePromise.catch(() => undefined);
  }
  await link.close();
  return outcome;
}
