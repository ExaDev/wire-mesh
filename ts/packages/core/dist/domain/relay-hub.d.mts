import { Connection } from "../ports/transport.mjs";
//#region src/domain/relay-hub.d.ts
export interface RelayHub {
  /** Drives one accepted connection until it closes: registers gossip-advertised devices, answers relay-connect by pairing and notifying the target, and forwards relay-data within established pairings. Resolves when the connection's frame stream ends. */
  handleConnection: (connection: Readonly<Connection>) => Promise<void>;
  /** Drops all registry and pairing state -- used by tests and by transport teardown. */
  stop: () => void;
}
export declare function createRelayHub(): RelayHub;
//#endregion