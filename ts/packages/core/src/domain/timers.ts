// The one place that calls a timer handle's runtime-specific methods. Code that runs in a browser or a Worker as well as in Node must not call `unref()` on what `setTimeout` returns: outside Node it is a number.

/** Stops a pending timer from keeping the process alive, where the runtime has that notion. Node's `setTimeout` returns an object with `unref()`; a browser's or a Worker's returns a number, which has nothing to unref and must not be called as if it did. */
export function unrefIfSupported(handle: unknown): void {
  if (
    typeof handle === "object" &&
    handle !== null &&
    "unref" in handle &&
    typeof handle.unref === "function"
  ) {
    Reflect.apply(handle.unref, handle, []);
  }
}
