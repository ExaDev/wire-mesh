// A minimal stand-in for the platform's WebSocket, firing events and recording sends -- it stands in for the runtime (the side of the port this adapter does NOT own), exactly what a unit test of an adapter should fake.

export class FakeWebSocket {
  binaryType = "arraybuffer";
  sent: ArrayBuffer[] = [];
  closed = false;
  private readonly listeners = new Map<
    string,
    ((event: { data?: unknown }) => void)[]
  >();

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  private dispatch(type: string, event?: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event ?? {});
    }
  }

  send(data: Readonly<ArrayBuffer>): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.dispatch("close");
  }

  // Test-side drivers
  emitMessage(data: Readonly<ArrayBuffer>): void {
    this.dispatch("message", { data });
  }

  /** A text (non-binary) message -- the protocol violation the adapter must treat as a connection-level failure. */
  emitText(text: string): void {
    this.dispatch("message", { data: text });
  }

  emitError(): void {
    this.dispatch("error");
  }

  accept(): void {
    // Present on the Workers server-side socket; a no-op in the fake.
  }
}
