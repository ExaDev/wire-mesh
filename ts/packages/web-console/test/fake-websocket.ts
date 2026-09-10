// A minimal stand-in for the browser's WebSocket, firing events and recording sends -- it stands in for the platform (the side of the port this adapter does NOT own), exactly what a unit test of an adapter should fake.

type Listener = (event: { data?: unknown }) => void;

export class FakeWebSocket {
  binaryType = "arraybuffer";
  sent: ArrayBuffer[] = [];
  closed = false;
  closeCode: number | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(public readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: Readonly<ArrayBuffer>): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code ?? null;
    this.dispatch("close");
  }

  // Test-side drivers
  emitMessage(data: Readonly<ArrayBuffer>): void {
    this.dispatch("message", { data });
  }

  emitText(text: string): void {
    this.dispatch("message", { data: text });
  }

  emitError(): void {
    this.dispatch("error");
  }

  private dispatch(type: string, event?: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event ?? {});
    }
  }
}
