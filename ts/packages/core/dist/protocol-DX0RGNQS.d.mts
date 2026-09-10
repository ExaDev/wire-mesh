import { z } from "zod";
//#region src/generated/protocol.d.ts
declare const dataHaveFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"data-have">;
  peer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "head-seq": z.ZodNumber;
}, z.core.$strip>>;
declare const dataRequestFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"data-request">;
  peer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "from-seq": z.ZodNumber;
}, z.core.$strip>>;
declare const dataEntriesFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"data-entries">;
  peer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "from-seq": z.ZodNumber;
  entries: z.ZodArray<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$strip>>;
declare const handleClaimsSchema: z.ZodLazy<z.ZodObject<{
  handle: z.ZodString;
  "device-id": z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "identity-key": z.ZodLazy<z.ZodLazy<z.ZodObject<{
    alg: z.ZodNumber;
    "public-key": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  }, z.core.$strip>>>;
  candidates: z.ZodOptional<z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    address: z.ZodString;
    kind: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"host">, z.ZodLiteral<"server-reflexive">, z.ZodLiteral<"relayed">]>>>;
    priority: z.ZodNumber;
  }, z.core.$strip>>>>>;
  mailboxes: z.ZodOptional<z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>>>;
  issued: z.ZodNumber;
  expires: z.ZodNumber;
}, z.core.$strip>>;
declare const handleRecordSchema: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  "1": z.ZodOptional<z.ZodNumber>;
  "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>;
declare const manageCommandParamsSchema: z.ZodLazy<z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"pty.spawn">;
  shell: z.ZodOptional<z.ZodString>;
  argv: z.ZodArray<z.ZodString>;
  cwd: z.ZodOptional<z.ZodString>;
  env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
  cols: z.ZodNumber;
  rows: z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"pty.write">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  bytes: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"pty.resize">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  cols: z.ZodNumber;
  rows: z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"pty.kill">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  signal: z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"proc.spawn">;
  argv: z.ZodArray<z.ZodString>;
  cwd: z.ZodOptional<z.ZodString>;
  env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"proc.signal">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  signal: z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"proc.kill">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"exec.list">;
}, z.core.$strip>>>]>, z.ZodObject<{}, z.core.$catchall<z.ZodUnknown>>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"webrtc.offer">;
  "negotiation-id": z.ZodNumber;
  sdp: z.ZodString;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"webrtc.answer">;
  "negotiation-id": z.ZodNumber;
  sdp: z.ZodString;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"webrtc.ice-candidate">;
  "negotiation-id": z.ZodNumber;
  candidate: z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    candidate: z.ZodString;
    "sdp-mid": z.ZodOptional<z.ZodString>;
    "sdp-m-line-index": z.ZodOptional<z.ZodNumber>;
    "username-fragment": z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>>;
}, z.core.$strip>>>]>]>>;
declare const ptySpawnSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"pty.spawn">;
  shell: z.ZodOptional<z.ZodString>;
  argv: z.ZodArray<z.ZodString>;
  cwd: z.ZodOptional<z.ZodString>;
  env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
  cols: z.ZodNumber;
  rows: z.ZodNumber;
}, z.core.$strip>>;
declare const ptyWriteSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"pty.write">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  bytes: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>>;
declare const ptyResizeSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"pty.resize">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  cols: z.ZodNumber;
  rows: z.ZodNumber;
}, z.core.$strip>>;
declare const ptyKillSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"pty.kill">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  signal: z.ZodNumber;
}, z.core.$strip>>;
declare const procSpawnSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"proc.spawn">;
  argv: z.ZodArray<z.ZodString>;
  cwd: z.ZodOptional<z.ZodString>;
  env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
}, z.core.$strip>>;
declare const procSignalSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"proc.signal">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  signal: z.ZodNumber;
}, z.core.$strip>>;
declare const procKillSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"proc.kill">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
}, z.core.$strip>>;
declare const execListSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"exec.list">;
}, z.core.$strip>>;
declare const execSessionInfoSchema: z.ZodLazy<z.ZodObject<{
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  kind: z.ZodUnion<readonly [z.ZodLiteral<"pty">, z.ZodLiteral<"proc">]>;
  argv: z.ZodOptional<z.ZodArray<z.ZodString>>;
  cwd: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
declare const frameVariantSchema: z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"handshake">;
  version: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  domains: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"core/management">, z.ZodLiteral<"core/exec">, z.ZodLiteral<"core/data">, z.ZodLiteral<"core/federation">, z.ZodLiteral<"core/webrtc">]>>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>>;
  params: z.ZodOptional<z.ZodObject<{}, z.core.$catchall<z.ZodUnknown>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"ping">;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"close">;
  reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"gossip">;
  peers: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    device: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
    addresses: z.ZodArray<z.ZodString>;
    "snapshot-seconds": z.ZodNumber;
  }, z.core.$strip>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"candidates">;
  candidates: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    address: z.ZodString;
    kind: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"host">, z.ZodLiteral<"server-reflexive">, z.ZodLiteral<"relayed">]>>>;
    priority: z.ZodNumber;
  }, z.core.$strip>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"sync-punch">;
  nonce: z.ZodNumber;
  "deadline-unix-ms": z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"observed-address">;
  address: z.ZodString;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-offer">;
  addresses: z.ZodArray<z.ZodString>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-connect">;
  "target-device": z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-data">;
  payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-inbound">;
  "source-device": z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"coordinator">;
  term: z.ZodNumber;
  coordinator: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "capacity-hint": z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"manage-request">;
  "request-id": z.ZodNumber;
  command: z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>;
    params: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.spawn">;
      shell: z.ZodOptional<z.ZodString>;
      argv: z.ZodArray<z.ZodString>;
      cwd: z.ZodOptional<z.ZodString>;
      env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
      cols: z.ZodNumber;
      rows: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.write">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      bytes: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.resize">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      cols: z.ZodNumber;
      rows: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.kill">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      signal: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"proc.spawn">;
      argv: z.ZodArray<z.ZodString>;
      cwd: z.ZodOptional<z.ZodString>;
      env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"proc.signal">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      signal: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"proc.kill">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"exec.list">;
    }, z.core.$strip>>>]>, z.ZodObject<{}, z.core.$catchall<z.ZodUnknown>>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"webrtc.offer">;
      "negotiation-id": z.ZodNumber;
      sdp: z.ZodString;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"webrtc.answer">;
      "negotiation-id": z.ZodNumber;
      sdp: z.ZodString;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"webrtc.ice-candidate">;
      "negotiation-id": z.ZodNumber;
      candidate: z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodObject<{
        candidate: z.ZodString;
        "sdp-mid": z.ZodOptional<z.ZodString>;
        "sdp-m-line-index": z.ZodOptional<z.ZodNumber>;
        "username-fragment": z.ZodOptional<z.ZodString>;
      }, z.core.$strip>>>>;
    }, z.core.$strip>>>]>]>>>;
  }, z.core.$strip>>>;
  scope: z.ZodLazy<z.ZodLazy<z.ZodObject<{
    kind: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>;
  token: z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    "1": z.ZodOptional<z.ZodNumber>;
    "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"manage-response">;
  "request-id": z.ZodNumber;
  outcome: z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
    result: z.ZodLiteral<"ok">;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    result: z.ZodLiteral<"error">;
    code: z.ZodString;
    message: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>]>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"revocation-announce">;
  entries: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    "1": z.ZodOptional<z.ZodNumber>;
    "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"stream-data">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  seq: z.ZodNumber;
  channel: z.ZodString;
  bytes: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"stream-ack">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  "ack-seq": z.ZodNumber;
  window: z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"stream-end">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  "exit-code": z.ZodOptional<z.ZodNumber>;
  "exit-signal": z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"data-have">;
  peer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "head-seq": z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"data-request">;
  peer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "from-seq": z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"data-entries">;
  peer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "from-seq": z.ZodNumber;
  entries: z.ZodArray<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$strip>>>]>>;
declare const frameSchema: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"handshake">;
  version: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  domains: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"core/management">, z.ZodLiteral<"core/exec">, z.ZodLiteral<"core/data">, z.ZodLiteral<"core/federation">, z.ZodLiteral<"core/webrtc">]>>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>>;
  params: z.ZodOptional<z.ZodObject<{}, z.core.$catchall<z.ZodUnknown>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"ping">;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"close">;
  reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"gossip">;
  peers: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    device: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
    addresses: z.ZodArray<z.ZodString>;
    "snapshot-seconds": z.ZodNumber;
  }, z.core.$strip>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"candidates">;
  candidates: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    address: z.ZodString;
    kind: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"host">, z.ZodLiteral<"server-reflexive">, z.ZodLiteral<"relayed">]>>>;
    priority: z.ZodNumber;
  }, z.core.$strip>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"sync-punch">;
  nonce: z.ZodNumber;
  "deadline-unix-ms": z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"observed-address">;
  address: z.ZodString;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-offer">;
  addresses: z.ZodArray<z.ZodString>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-connect">;
  "target-device": z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-data">;
  payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-inbound">;
  "source-device": z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"coordinator">;
  term: z.ZodNumber;
  coordinator: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "capacity-hint": z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"manage-request">;
  "request-id": z.ZodNumber;
  command: z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>;
    params: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.spawn">;
      shell: z.ZodOptional<z.ZodString>;
      argv: z.ZodArray<z.ZodString>;
      cwd: z.ZodOptional<z.ZodString>;
      env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
      cols: z.ZodNumber;
      rows: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.write">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      bytes: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.resize">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      cols: z.ZodNumber;
      rows: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.kill">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      signal: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"proc.spawn">;
      argv: z.ZodArray<z.ZodString>;
      cwd: z.ZodOptional<z.ZodString>;
      env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"proc.signal">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      signal: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"proc.kill">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"exec.list">;
    }, z.core.$strip>>>]>, z.ZodObject<{}, z.core.$catchall<z.ZodUnknown>>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"webrtc.offer">;
      "negotiation-id": z.ZodNumber;
      sdp: z.ZodString;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"webrtc.answer">;
      "negotiation-id": z.ZodNumber;
      sdp: z.ZodString;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"webrtc.ice-candidate">;
      "negotiation-id": z.ZodNumber;
      candidate: z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodObject<{
        candidate: z.ZodString;
        "sdp-mid": z.ZodOptional<z.ZodString>;
        "sdp-m-line-index": z.ZodOptional<z.ZodNumber>;
        "username-fragment": z.ZodOptional<z.ZodString>;
      }, z.core.$strip>>>>;
    }, z.core.$strip>>>]>]>>>;
  }, z.core.$strip>>>;
  scope: z.ZodLazy<z.ZodLazy<z.ZodObject<{
    kind: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>;
  token: z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    "1": z.ZodOptional<z.ZodNumber>;
    "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"manage-response">;
  "request-id": z.ZodNumber;
  outcome: z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
    result: z.ZodLiteral<"ok">;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    result: z.ZodLiteral<"error">;
    code: z.ZodString;
    message: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>]>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"revocation-announce">;
  entries: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    "1": z.ZodOptional<z.ZodNumber>;
    "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"stream-data">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  seq: z.ZodNumber;
  channel: z.ZodString;
  bytes: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"stream-ack">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  "ack-seq": z.ZodNumber;
  window: z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"stream-end">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  "exit-code": z.ZodOptional<z.ZodNumber>;
  "exit-signal": z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"data-have">;
  peer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "head-seq": z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"data-request">;
  peer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "from-seq": z.ZodNumber;
}, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"data-entries">;
  peer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "from-seq": z.ZodNumber;
  entries: z.ZodArray<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$strip>>>]>>>>;
declare const protocolVersionSchema: z.ZodLazy<z.ZodNumber>;
declare const domainIdSchema: z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"core/management">, z.ZodLiteral<"core/exec">, z.ZodLiteral<"core/data">, z.ZodLiteral<"core/federation">, z.ZodLiteral<"core/webrtc">]>>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>;
declare const coreDomainNameSchema: z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"core/management">, z.ZodLiteral<"core/exec">, z.ZodLiteral<"core/data">, z.ZodLiteral<"core/federation">, z.ZodLiteral<"core/webrtc">]>>;
declare const namespacedDomainIdSchema: z.ZodLazy<z.ZodString>;
declare const privateUseDomainIdSchema: z.ZodLazy<z.ZodString>;
declare const handshakeFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"handshake">;
  version: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  domains: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"core/management">, z.ZodLiteral<"core/exec">, z.ZodLiteral<"core/data">, z.ZodLiteral<"core/federation">, z.ZodLiteral<"core/webrtc">]>>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>>;
  params: z.ZodOptional<z.ZodObject<{}, z.core.$catchall<z.ZodUnknown>>>;
}, z.core.$strip>>;
declare const identityKeySchema: z.ZodLazy<z.ZodObject<{
  alg: z.ZodNumber;
  "public-key": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>>;
declare const deviceIdSchema: z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
declare const peerIdentitySchema: z.ZodLazy<z.ZodObject<{
  "device-id": z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "identity-key": z.ZodLazy<z.ZodLazy<z.ZodObject<{
    alg: z.ZodNumber;
    "public-key": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  }, z.core.$strip>>>;
  certificate: z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$strip>>;
declare const manageCommandSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>;
  params: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"pty.spawn">;
    shell: z.ZodOptional<z.ZodString>;
    argv: z.ZodArray<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
    cols: z.ZodNumber;
    rows: z.ZodNumber;
  }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"pty.write">;
    session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
    bytes: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"pty.resize">;
    session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
    cols: z.ZodNumber;
    rows: z.ZodNumber;
  }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"pty.kill">;
    session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
    signal: z.ZodNumber;
  }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"proc.spawn">;
    argv: z.ZodArray<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
  }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"proc.signal">;
    session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
    signal: z.ZodNumber;
  }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"proc.kill">;
    session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"exec.list">;
  }, z.core.$strip>>>]>, z.ZodObject<{}, z.core.$catchall<z.ZodUnknown>>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"webrtc.offer">;
    "negotiation-id": z.ZodNumber;
    sdp: z.ZodString;
  }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"webrtc.answer">;
    "negotiation-id": z.ZodNumber;
    sdp: z.ZodString;
  }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"webrtc.ice-candidate">;
    "negotiation-id": z.ZodNumber;
    candidate: z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodObject<{
      candidate: z.ZodString;
      "sdp-mid": z.ZodOptional<z.ZodString>;
      "sdp-m-line-index": z.ZodOptional<z.ZodNumber>;
      "username-fragment": z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>>;
  }, z.core.$strip>>>]>]>>>;
}, z.core.$strip>>;
declare const manageRequestFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"manage-request">;
  "request-id": z.ZodNumber;
  command: z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>;
    params: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.spawn">;
      shell: z.ZodOptional<z.ZodString>;
      argv: z.ZodArray<z.ZodString>;
      cwd: z.ZodOptional<z.ZodString>;
      env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
      cols: z.ZodNumber;
      rows: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.write">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      bytes: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.resize">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      cols: z.ZodNumber;
      rows: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"pty.kill">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      signal: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"proc.spawn">;
      argv: z.ZodArray<z.ZodString>;
      cwd: z.ZodOptional<z.ZodString>;
      env: z.ZodObject<{}, z.core.$catchall<z.ZodString>>;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"proc.signal">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
      signal: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"proc.kill">;
      session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"exec.list">;
    }, z.core.$strip>>>]>, z.ZodObject<{}, z.core.$catchall<z.ZodUnknown>>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"webrtc.offer">;
      "negotiation-id": z.ZodNumber;
      sdp: z.ZodString;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"webrtc.answer">;
      "negotiation-id": z.ZodNumber;
      sdp: z.ZodString;
    }, z.core.$strip>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"webrtc.ice-candidate">;
      "negotiation-id": z.ZodNumber;
      candidate: z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodObject<{
        candidate: z.ZodString;
        "sdp-mid": z.ZodOptional<z.ZodString>;
        "sdp-m-line-index": z.ZodOptional<z.ZodNumber>;
        "username-fragment": z.ZodOptional<z.ZodString>;
      }, z.core.$strip>>>>;
    }, z.core.$strip>>>]>]>>>;
  }, z.core.$strip>>>;
  scope: z.ZodLazy<z.ZodLazy<z.ZodObject<{
    kind: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>;
  token: z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    "1": z.ZodOptional<z.ZodNumber>;
    "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>>;
}, z.core.$strip>>;
declare const manageOkSchema: z.ZodLazy<z.ZodObject<{
  result: z.ZodLiteral<"ok">;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const manageErrorSchema: z.ZodLazy<z.ZodObject<{
  result: z.ZodLiteral<"error">;
  code: z.ZodString;
  message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
declare const manageResponseFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"manage-response">;
  "request-id": z.ZodNumber;
  outcome: z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
    result: z.ZodLiteral<"ok">;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    result: z.ZodLiteral<"error">;
    code: z.ZodString;
    message: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>]>;
}, z.core.$strip>>;
declare const revocationClaimsSchema: z.ZodLazy<z.ZodObject<{
  "token-id": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  issuer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "issuer-key": z.ZodLazy<z.ZodLazy<z.ZodObject<{
    alg: z.ZodNumber;
    "public-key": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  }, z.core.$strip>>>;
  "revoked-at": z.ZodNumber;
}, z.core.$strip>>;
declare const revocationEntrySchema: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  "1": z.ZodOptional<z.ZodNumber>;
  "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>;
declare const revocationAnnounceFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"revocation-announce">;
  entries: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    "1": z.ZodOptional<z.ZodNumber>;
    "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>>;
}, z.core.$strip>>;
declare const streamSessionSchema: z.ZodLazy<z.ZodNumber>;
declare const streamDataFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"stream-data">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  seq: z.ZodNumber;
  channel: z.ZodString;
  bytes: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>>;
declare const streamAckFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"stream-ack">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  "ack-seq": z.ZodNumber;
  window: z.ZodNumber;
}, z.core.$strip>>;
declare const streamEndFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"stream-end">;
  session: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  "exit-code": z.ZodOptional<z.ZodNumber>;
  "exit-signal": z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>>;
declare const capabilityVerbSchema: z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>;
declare const coreCapabilitySchema: z.ZodLazy<z.ZodString>;
declare const namespacedCapabilitySchema: z.ZodLazy<z.ZodString>;
declare const privateUseCapabilitySchema: z.ZodLazy<z.ZodString>;
declare const capabilityScopeSchema: z.ZodLazy<z.ZodObject<{
  kind: z.ZodString;
  path: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
declare const coseHeaderAlgSchema: z.ZodLazy<z.ZodLiteral<1>>;
declare const coseHeaderKidSchema: z.ZodLazy<z.ZodLiteral<4>>;
declare const coseHeaderLabelSchema: z.ZodLazy<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
declare const coseTokenHeadersSchema: z.ZodLazy<z.ZodObject<{
  "1": z.ZodOptional<z.ZodNumber>;
  "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const coseSign1Schema: z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  "1": z.ZodOptional<z.ZodNumber>;
  "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>;
declare const capabilityTokenSchema: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  "1": z.ZodOptional<z.ZodNumber>;
  "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>;
declare const tokenClaimsSchema: z.ZodLazy<z.ZodObject<{
  "token-id": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  issuer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "issuer-key": z.ZodLazy<z.ZodLazy<z.ZodObject<{
    alg: z.ZodNumber;
    "public-key": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  }, z.core.$strip>>>;
  bearer: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  capability: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>;
  scope: z.ZodLazy<z.ZodLazy<z.ZodObject<{
    kind: z.ZodString;
    path: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>;
  expires: z.ZodNumber;
  "not-before": z.ZodOptional<z.ZodNumber>;
  parent: z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const pingFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"ping">;
}, z.core.$strip>>;
declare const closeFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"close">;
  reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
declare const peerAdvertSchema: z.ZodLazy<z.ZodObject<{
  device: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  addresses: z.ZodArray<z.ZodString>;
  "snapshot-seconds": z.ZodNumber;
}, z.core.$strip>>;
declare const gossipFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"gossip">;
  peers: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    device: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
    addresses: z.ZodArray<z.ZodString>;
    "snapshot-seconds": z.ZodNumber;
  }, z.core.$strip>>>>;
}, z.core.$strip>>;
declare const candidateKindSchema: z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"host">, z.ZodLiteral<"server-reflexive">, z.ZodLiteral<"relayed">]>>;
declare const wireCandidateSchema: z.ZodLazy<z.ZodObject<{
  address: z.ZodString;
  kind: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"host">, z.ZodLiteral<"server-reflexive">, z.ZodLiteral<"relayed">]>>>;
  priority: z.ZodNumber;
}, z.core.$strip>>;
declare const candidatesFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"candidates">;
  candidates: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    address: z.ZodString;
    kind: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"host">, z.ZodLiteral<"server-reflexive">, z.ZodLiteral<"relayed">]>>>;
    priority: z.ZodNumber;
  }, z.core.$strip>>>>;
}, z.core.$strip>>;
declare const syncPunchFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"sync-punch">;
  nonce: z.ZodNumber;
  "deadline-unix-ms": z.ZodNumber;
}, z.core.$strip>>;
declare const observedAddressFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"observed-address">;
  address: z.ZodString;
}, z.core.$strip>>;
declare const relayOfferFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-offer">;
  addresses: z.ZodArray<z.ZodString>;
}, z.core.$strip>>;
declare const relayConnectFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-connect">;
  "target-device": z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
}, z.core.$strip>>;
declare const relayDataFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-data">;
  payload: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strip>>;
declare const relayInboundFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"relay-inbound">;
  "source-device": z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
}, z.core.$strip>>;
declare const coordinatorFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"coordinator">;
  term: z.ZodNumber;
  coordinator: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "capacity-hint": z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>>;
declare const webrtcOfferSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"webrtc.offer">;
  "negotiation-id": z.ZodNumber;
  sdp: z.ZodString;
}, z.core.$strip>>;
declare const webrtcAnswerSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"webrtc.answer">;
  "negotiation-id": z.ZodNumber;
  sdp: z.ZodString;
}, z.core.$strip>>;
declare const webrtcIceCandidateSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"webrtc.ice-candidate">;
  "negotiation-id": z.ZodNumber;
  candidate: z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    candidate: z.ZodString;
    "sdp-mid": z.ZodOptional<z.ZodString>;
    "sdp-m-line-index": z.ZodOptional<z.ZodNumber>;
    "username-fragment": z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>>;
}, z.core.$strip>>;
declare const iceCandidateInitSchema: z.ZodLazy<z.ZodObject<{
  candidate: z.ZodString;
  "sdp-mid": z.ZodOptional<z.ZodString>;
  "sdp-m-line-index": z.ZodOptional<z.ZodNumber>;
  "username-fragment": z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
type DataHaveFrame = z.infer<typeof dataHaveFrameSchema>;
type DataRequestFrame = z.infer<typeof dataRequestFrameSchema>;
type DataEntriesFrame = z.infer<typeof dataEntriesFrameSchema>;
type HandleClaims = z.infer<typeof handleClaimsSchema>;
type HandleRecord = z.infer<typeof handleRecordSchema>;
type ManageCommandParams = z.infer<typeof manageCommandParamsSchema>;
type PtySpawn = z.infer<typeof ptySpawnSchema>;
type PtyWrite = z.infer<typeof ptyWriteSchema>;
type PtyResize = z.infer<typeof ptyResizeSchema>;
type PtyKill = z.infer<typeof ptyKillSchema>;
type ProcSpawn = z.infer<typeof procSpawnSchema>;
type ProcSignal = z.infer<typeof procSignalSchema>;
type ProcKill = z.infer<typeof procKillSchema>;
type ExecList = z.infer<typeof execListSchema>;
type ExecSessionInfo = z.infer<typeof execSessionInfoSchema>;
type FrameVariant = z.infer<typeof frameVariantSchema>;
type Frame = z.infer<typeof frameSchema>;
type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
type DomainId = z.infer<typeof domainIdSchema>;
type CoreDomainName = z.infer<typeof coreDomainNameSchema>;
type NamespacedDomainId = z.infer<typeof namespacedDomainIdSchema>;
type PrivateUseDomainId = z.infer<typeof privateUseDomainIdSchema>;
type HandshakeFrame = z.infer<typeof handshakeFrameSchema>;
type IdentityKey = z.infer<typeof identityKeySchema>;
type DeviceId = z.infer<typeof deviceIdSchema>;
type PeerIdentity = z.infer<typeof peerIdentitySchema>;
type ManageCommand = z.infer<typeof manageCommandSchema>;
type ManageRequestFrame = z.infer<typeof manageRequestFrameSchema>;
type ManageOk = z.infer<typeof manageOkSchema>;
type ManageError = z.infer<typeof manageErrorSchema>;
type ManageResponseFrame = z.infer<typeof manageResponseFrameSchema>;
type RevocationClaims = z.infer<typeof revocationClaimsSchema>;
type RevocationEntry = z.infer<typeof revocationEntrySchema>;
type RevocationAnnounceFrame = z.infer<typeof revocationAnnounceFrameSchema>;
type StreamSession = z.infer<typeof streamSessionSchema>;
type StreamDataFrame = z.infer<typeof streamDataFrameSchema>;
type StreamAckFrame = z.infer<typeof streamAckFrameSchema>;
type StreamEndFrame = z.infer<typeof streamEndFrameSchema>;
type CapabilityVerb = z.infer<typeof capabilityVerbSchema>;
type CoreCapability = z.infer<typeof coreCapabilitySchema>;
type NamespacedCapability = z.infer<typeof namespacedCapabilitySchema>;
type PrivateUseCapability = z.infer<typeof privateUseCapabilitySchema>;
type CapabilityScope = z.infer<typeof capabilityScopeSchema>;
type CoseHeaderAlg = z.infer<typeof coseHeaderAlgSchema>;
type CoseHeaderKid = z.infer<typeof coseHeaderKidSchema>;
type CoseHeaderLabel = z.infer<typeof coseHeaderLabelSchema>;
type CoseTokenHeaders = z.infer<typeof coseTokenHeadersSchema>;
type CoseSign1 = z.infer<typeof coseSign1Schema>;
type CapabilityToken = z.infer<typeof capabilityTokenSchema>;
type TokenClaims = z.infer<typeof tokenClaimsSchema>;
type PingFrame = z.infer<typeof pingFrameSchema>;
type CloseFrame = z.infer<typeof closeFrameSchema>;
type PeerAdvert = z.infer<typeof peerAdvertSchema>;
type GossipFrame = z.infer<typeof gossipFrameSchema>;
type CandidateKind = z.infer<typeof candidateKindSchema>;
type WireCandidate = z.infer<typeof wireCandidateSchema>;
type CandidatesFrame = z.infer<typeof candidatesFrameSchema>;
type SyncPunchFrame = z.infer<typeof syncPunchFrameSchema>;
type ObservedAddressFrame = z.infer<typeof observedAddressFrameSchema>;
type RelayOfferFrame = z.infer<typeof relayOfferFrameSchema>;
type RelayConnectFrame = z.infer<typeof relayConnectFrameSchema>;
type RelayDataFrame = z.infer<typeof relayDataFrameSchema>;
type RelayInboundFrame = z.infer<typeof relayInboundFrameSchema>;
type CoordinatorFrame = z.infer<typeof coordinatorFrameSchema>;
type WebrtcOffer = z.infer<typeof webrtcOfferSchema>;
type WebrtcAnswer = z.infer<typeof webrtcAnswerSchema>;
type WebrtcIceCandidate = z.infer<typeof webrtcIceCandidateSchema>;
type IceCandidateInit = z.infer<typeof iceCandidateInitSchema>;
//#endregion
export { RelayDataFrame as $, peerAdvertSchema as $t, ManageCommand as A, dataHaveFrameSchema as At, PeerIdentity as B, handleRecordSchema as Bt, FrameVariant as C, syncPunchFrameSchema as Cn, coreDomainNameSchema as Ct, HandshakeFrame as D, webrtcOfferSchema as Dn, coseSign1Schema as Dt, HandleRecord as E, webrtcIceCandidateSchema as En, coseHeaderLabelSchema as Et, ManageResponseFrame as F, execSessionInfoSchema as Ft, ProcSignal as G, manageCommandSchema as Gt, PrivateUseCapability as H, iceCandidateInitSchema as Ht, NamespacedCapability as I, frameSchema as It, PtyKill as J, manageRequestFrameSchema as Jt, ProcSpawn as K, manageErrorSchema as Kt, NamespacedDomainId as L, frameVariantSchema as Lt, ManageError as M, deviceIdSchema as Mt, ManageOk as N, domainIdSchema as Nt, IceCandidateInit as O, wireCandidateSchema as On, coseTokenHeadersSchema as Ot, ManageRequestFrame as P, execListSchema as Pt, RelayConnectFrame as Q, observedAddressFrameSchema as Qt, ObservedAddressFrame as R, gossipFrameSchema as Rt, Frame as S, streamSessionSchema as Sn, coreCapabilitySchema as St, HandleClaims as T, webrtcAnswerSchema as Tn, coseHeaderKidSchema as Tt, PrivateUseDomainId as U, identityKeySchema as Ut, PingFrame as V, handshakeFrameSchema as Vt, ProcKill as W, manageCommandParamsSchema as Wt, PtySpawn as X, namespacedCapabilitySchema as Xt, PtyResize as Y, manageResponseFrameSchema as Yt, PtyWrite as Z, namespacedDomainIdSchema as Zt, DataRequestFrame as _, revocationClaimsSchema as _n, capabilityScopeSchema as _t, CapabilityVerb as a, procSignalSchema as an, StreamAckFrame as at, ExecList as b, streamDataFrameSchema as bn, closeFrameSchema as bt, CoreCapability as c, ptyKillSchema as cn, StreamSession as ct, CoseHeaderKid as d, ptyWriteSchema as dn, WebrtcAnswer as dt, peerIdentitySchema as en, RelayInboundFrame as et, CoseHeaderLabel as f, relayConnectFrameSchema as fn, WebrtcIceCandidate as ft, DataHaveFrame as g, revocationAnnounceFrameSchema as gn, candidatesFrameSchema as gt, DataEntriesFrame as h, relayOfferFrameSchema as hn, candidateKindSchema as ht, CapabilityToken as i, procKillSchema as in, RevocationEntry as it, ManageCommandParams as j, dataRequestFrameSchema as jt, IdentityKey as k, dataEntriesFrameSchema as kt, CoreDomainName as l, ptyResizeSchema as ln, SyncPunchFrame as lt, CoseTokenHeaders as m, relayInboundFrameSchema as mn, WireCandidate as mt, CandidatesFrame as n, privateUseCapabilitySchema as nn, RevocationAnnounceFrame as nt, CloseFrame as o, procSpawnSchema as on, StreamDataFrame as ot, CoseSign1 as p, relayDataFrameSchema as pn, WebrtcOffer as pt, ProtocolVersion as q, manageOkSchema as qt, CapabilityScope as r, privateUseDomainIdSchema as rn, RevocationClaims as rt, CoordinatorFrame as s, protocolVersionSchema as sn, StreamEndFrame as st, CandidateKind as t, pingFrameSchema as tn, RelayOfferFrame as tt, CoseHeaderAlg as u, ptySpawnSchema as un, TokenClaims as ut, DeviceId as v, revocationEntrySchema as vn, capabilityTokenSchema as vt, GossipFrame as w, tokenClaimsSchema as wn, coseHeaderAlgSchema as wt, ExecSessionInfo as x, streamEndFrameSchema as xn, coordinatorFrameSchema as xt, DomainId as y, streamAckFrameSchema as yn, capabilityVerbSchema as yt, PeerAdvert as z, handleClaimsSchema as zt };