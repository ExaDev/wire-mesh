import { describe, expect, it } from "vitest";
import { createAsyncQueue } from "../src/domain/async-queue.js";

describe("createAsyncQueue", () => {
  it("delivers a pushed value to a consumer already waiting on next()", async () => {
    const queue = createAsyncQueue<string>();
    const iterator = queue.stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.push("hello");
    await expect(pending).resolves.toEqual({ value: "hello", done: false });
  });

  it("buffers a pushed value for a consumer that asks later", async () => {
    const queue = createAsyncQueue<string>();
    queue.push("buffered");
    const iterator = queue.stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      value: "buffered",
      done: false,
    });
  });

  it("delivers values in push order across multiple next() calls", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    const iterator = queue.stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
  });

  it("shares its backlog across every iterator obtained from the same stream", async () => {
    const queue = createAsyncQueue<number>();
    const first = queue.stream[Symbol.asyncIterator]();
    const second = queue.stream[Symbol.asyncIterator]();
    const firstPending = first.next();
    queue.push(1);
    queue.push(2);
    await expect(firstPending).resolves.toEqual({ value: 1, done: false });
    await expect(second.next()).resolves.toEqual({ value: 2, done: false });
  });
});
