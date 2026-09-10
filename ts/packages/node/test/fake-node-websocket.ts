// A minimal stand-in for `ws`'s WebSocket, EventEmitter-shaped like the real thing -- it stands in for the runtime (the side of the port this adapter does NOT own), exactly what a unit test of an adapter should fake. Mirrors FakeWebSocket's role in the other packages' tests, adjusted for `ws`'s `.on`/`.once` API and its `(data, isBinary)` message signature instead of a MessageEvent.

type Listener = (...args: readonly unknown[]) => void;

export class FakeNodeWebSocket {
  sent: (string | Uint8Array)[] = [];
  closed = false;
  closeCode: number | undefined;
  private readonly listeners = new Map<string, Listener[]>();

  on(type: string, listener: Listener): this {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    return this;
  }

  once(type: string, listener: Listener): this {
    return this.on(type, listener);
  }

  private dispatch(type: string, ...args: readonly unknown[]): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(...args);
    }
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
    this.dispatch("close");
  }

  // Test-side drivers
  emitMessage(data: Uint8Array, isBinary: boolean): void {
    this.dispatch("message", data, isBinary);
  }

  emitError(): void {
    this.dispatch("error");
  }
}
