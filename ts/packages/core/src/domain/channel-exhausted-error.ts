/** Thrown when a secure channel's send counter is spent: nothing more can be sealed on that channel, and a new handshake gives a fresh counter. The session forgets such a channel, so the next send to the peer starts one; a caller that sees this error from a send can retry it. */
export class ChannelExhaustedError extends Error {
  constructor() {
    super("the channel's send counter is exhausted");
    this.name = "ChannelExhaustedError";
  }
}
