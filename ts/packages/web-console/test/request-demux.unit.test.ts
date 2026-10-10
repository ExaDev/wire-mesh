import { describe, expect, it } from "vitest";
import { createAsyncQueue } from "wire-mesh-core/domain/async-queue";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";
import { createRequestDemux } from "../src/request-demux.js";

function request(verb: string, requestId: number): IncomingManageRequest {
  return {
    requestId,
    command: { verb, params: { verb: "x" } },
    scope: { kind: "node" },
    respond: async () => Promise.resolve(),
  };
}

async function take(
  stream: Readonly<AsyncIterable<IncomingManageRequest>>,
  count: number,
): Promise<number[]> {
  const ids: number[] = [];
  for await (const item of stream) {
    ids.push(item.requestId);
    if (ids.length === count) return ids;
  }

  return ids;
}

const A_FIRST = 1;
const B_FIRST = 2;
const A_SECOND = 3;
const B_SECOND = 4;
const EARLY = 7;
const SETTLE_MS = 5;

describe("createRequestDemux", () => {
  it("gives each stream only the requests of its own verb, in arrival order", async () => {
    const source = createAsyncQueue<IncomingManageRequest>();
    const demux = createRequestDemux(source.stream, ["a", "b"]);
    const fromA = take(demux.stream("a"), 2);
    const fromB = take(demux.stream("b"), 2);

    source.push(request("a", A_FIRST));
    source.push(request("b", B_FIRST));
    source.push(request("a", A_SECOND));
    source.push(request("b", B_SECOND));

    expect(await fromA).toEqual([A_FIRST, A_SECOND]);
    expect(await fromB).toEqual([B_FIRST, B_SECOND]);
  });

  it("drops a request whose verb has no stream, without disturbing the others", async () => {
    const source = createAsyncQueue<IncomingManageRequest>();
    const demux = createRequestDemux(source.stream, ["a"]);
    const fromA = take(demux.stream("a"), 1);

    source.push(request("unlisted", A_FIRST));
    source.push(request("a", B_FIRST));

    expect(await fromA).toEqual([B_FIRST]);
  });

  it("keeps a request that arrives before its consumer starts reading", async () => {
    const source = createAsyncQueue<IncomingManageRequest>();
    const demux = createRequestDemux(source.stream, ["a"]);

    source.push(request("a", EARLY));
    await new Promise((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });

    expect(await take(demux.stream("a"), 1)).toEqual([EARLY]);
  });

  it("refuses a stream for a verb it was not built with", () => {
    const source = createAsyncQueue<IncomingManageRequest>();
    const demux = createRequestDemux(source.stream, ["a"]);

    expect(() => demux.stream("b")).toThrow("not built to carry verb b");
  });
});
