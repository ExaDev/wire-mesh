// The one definition of the gossip frame's JSON-serialisable shape, shared by the browser harness that converts to and from it and by the Playwright spec that builds one to send.
//
// It lives in its own module, carrying no runtime code and no global declaration, so both sides can import it without either TypeScript program pulling in the other's globals. Kept separate because the two used to hold their own hand-written copies: peer-advert gained its identity-key and signature (wire-mesh#225), the harness's copy was updated, the spec's was not, and the mismatch surfaced only as a runtime failure in the end-to-end run.

/** A gossip frame as it crosses the page.evaluate boundary, with every byte string carried as a plain number array, since page.evaluate's arguments and return values must be JSON-serialisable. A narrow (de)serialisation for exactly the one frame shape the live-check exchanges, never a generic Frame codec. */
export interface WireGossip {
  type: "gossip";
  peers: {
    device: number[];
    addresses: string[];
    "snapshot-seconds": number;
    "identity-key": { alg: number; "public-key": number[] };
    signature: number[];
  }[];
}
