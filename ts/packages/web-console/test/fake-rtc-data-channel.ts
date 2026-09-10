// A minimal stand-in for RTCDataChannel, firing events and recording sends -- it stands in for the platform (the side of the port this adapter does NOT own), exactly what a unit test of an adapter should fake. Mirrors fake-websocket.ts's exact shape/convention, adapted for RTCDataChannel's readyState instead of WebSocket's closed/closeCode.

type Listener = (event: { data?: unknown }) => void;

export class FakeRtcDataChannel {
  binaryType = "arraybuffer";
  sent: ArrayBuffer[] = [];
  readyState: "connecting" | "open" | "closing" | "closed" = "open";
  private readonly listeners = new Map<string, Listener[]>();

  send(data: Readonly<ArrayBuffer>): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = "closed";
    this.dispatch("close");
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
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

  emitClose(): void {
    this.close();
  }

  private dispatch(type: string, event?: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event ?? {});
    }
  }
}
