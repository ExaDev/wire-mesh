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
  verb: z.ZodLiteral<"room.send">;
  "message-id": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  "sent-at": z.ZodNumber;
  text: z.ZodString;
  "content-type": z.ZodOptional<z.ZodString>;
  refs: z.ZodOptional<z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    id: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    relation: z.ZodString;
  }, z.core.$strip>>>>>;
}, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.read">;
  messages: z.ZodArray<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  at: z.ZodNumber;
}, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.leave">;
}, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.members">;
}, z.core.$catchall<z.ZodUnknown>>>>]>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.join">;
}, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.invite">;
  invitee: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  token: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    "1": z.ZodOptional<z.ZodNumber>;
    "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>;
}, z.core.$catchall<z.ZodUnknown>>>>]>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
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
  domains: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"core/management">, z.ZodLiteral<"core/exec">, z.ZodLiteral<"core/data">, z.ZodLiteral<"core/federation">, z.ZodLiteral<"core/webrtc">, z.ZodLiteral<"core/room">]>>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>>;
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
  "to-device": z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>>;
  "from-device": z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>>;
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
      verb: z.ZodLiteral<"room.send">;
      "message-id": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
      "sent-at": z.ZodNumber;
      text: z.ZodString;
      "content-type": z.ZodOptional<z.ZodString>;
      refs: z.ZodOptional<z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
        id: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
        relation: z.ZodString;
      }, z.core.$strip>>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.read">;
      messages: z.ZodArray<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
      at: z.ZodNumber;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.leave">;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.members">;
    }, z.core.$catchall<z.ZodUnknown>>>>]>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.join">;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.invite">;
      invitee: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
      token: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
        "1": z.ZodOptional<z.ZodNumber>;
        "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
      }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>]>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
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
  domains: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"core/management">, z.ZodLiteral<"core/exec">, z.ZodLiteral<"core/data">, z.ZodLiteral<"core/federation">, z.ZodLiteral<"core/webrtc">, z.ZodLiteral<"core/room">]>>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>>;
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
  "to-device": z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>>;
  "from-device": z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>>;
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
      verb: z.ZodLiteral<"room.send">;
      "message-id": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
      "sent-at": z.ZodNumber;
      text: z.ZodString;
      "content-type": z.ZodOptional<z.ZodString>;
      refs: z.ZodOptional<z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
        id: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
        relation: z.ZodString;
      }, z.core.$strip>>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.read">;
      messages: z.ZodArray<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
      at: z.ZodNumber;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.leave">;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.members">;
    }, z.core.$catchall<z.ZodUnknown>>>>]>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.join">;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.invite">;
      invitee: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
      token: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
        "1": z.ZodOptional<z.ZodNumber>;
        "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
      }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>]>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
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
declare const domainIdSchema: z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"core/management">, z.ZodLiteral<"core/exec">, z.ZodLiteral<"core/data">, z.ZodLiteral<"core/federation">, z.ZodLiteral<"core/webrtc">, z.ZodLiteral<"core/room">]>>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>;
declare const coreDomainNameSchema: z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"core/management">, z.ZodLiteral<"core/exec">, z.ZodLiteral<"core/data">, z.ZodLiteral<"core/federation">, z.ZodLiteral<"core/webrtc">, z.ZodLiteral<"core/room">]>>;
declare const namespacedDomainIdSchema: z.ZodLazy<z.ZodString>;
declare const privateUseDomainIdSchema: z.ZodLazy<z.ZodString>;
declare const handshakeFrameSchema: z.ZodLazy<z.ZodObject<{
  type: z.ZodLiteral<"handshake">;
  version: z.ZodLazy<z.ZodLazy<z.ZodNumber>>;
  domains: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLiteral<"core/management">, z.ZodLiteral<"core/exec">, z.ZodLiteral<"core/data">, z.ZodLiteral<"core/federation">, z.ZodLiteral<"core/webrtc">, z.ZodLiteral<"core/room">]>>>, z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>>;
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
    verb: z.ZodLiteral<"room.send">;
    "message-id": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    "sent-at": z.ZodNumber;
    text: z.ZodString;
    "content-type": z.ZodOptional<z.ZodString>;
    refs: z.ZodOptional<z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
      id: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
      relation: z.ZodString;
    }, z.core.$strip>>>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"room.read">;
    messages: z.ZodArray<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
    at: z.ZodNumber;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"room.leave">;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"room.members">;
  }, z.core.$catchall<z.ZodUnknown>>>>]>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"room.join">;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    verb: z.ZodLiteral<"room.invite">;
    invitee: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
    token: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      "1": z.ZodOptional<z.ZodNumber>;
      "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>]>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
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
      verb: z.ZodLiteral<"room.send">;
      "message-id": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
      "sent-at": z.ZodNumber;
      text: z.ZodString;
      "content-type": z.ZodOptional<z.ZodString>;
      refs: z.ZodOptional<z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
        id: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
        relation: z.ZodString;
      }, z.core.$strip>>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.read">;
      messages: z.ZodArray<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
      at: z.ZodNumber;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.leave">;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.members">;
    }, z.core.$catchall<z.ZodUnknown>>>>]>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.join">;
    }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
      verb: z.ZodLiteral<"room.invite">;
      invitee: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
      token: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
        "1": z.ZodOptional<z.ZodNumber>;
        "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
      }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>]>, z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodObject<{
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
declare const roomPathSchema: z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>;
declare const deviceIdHexSchema: z.ZodLazy<z.ZodString>;
declare const ownerNamedRoomPathSchema: z.ZodLazy<z.ZodString>;
declare const dmRoomPathSchema: z.ZodLazy<z.ZodString>;
declare const roomSendSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.send">;
  "message-id": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  "sent-at": z.ZodNumber;
  text: z.ZodString;
  "content-type": z.ZodOptional<z.ZodString>;
  refs: z.ZodOptional<z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    id: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    relation: z.ZodString;
  }, z.core.$strip>>>>>;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const roomReadSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.read">;
  messages: z.ZodArray<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  at: z.ZodNumber;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const roomLeaveSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.leave">;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const roomMembersSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.members">;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const messageRefSchema: z.ZodLazy<z.ZodObject<{
  id: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  relation: z.ZodString;
}, z.core.$strip>>;
declare const roomJoinSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.join">;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const roomInviteSchema: z.ZodLazy<z.ZodObject<{
  verb: z.ZodLiteral<"room.invite">;
  invitee: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  token: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    "1": z.ZodOptional<z.ZodNumber>;
    "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const roomMemberSchema: z.ZodLazy<z.ZodObject<{
  device: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const roomJoinOkSchema: z.ZodLazy<z.ZodObject<{
  result: z.ZodLiteral<"ok">;
  "granted-token": z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    "1": z.ZodOptional<z.ZodNumber>;
    "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>;
  members: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    device: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>>;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const roomMembersOkSchema: z.ZodLazy<z.ZodObject<{
  result: z.ZodLiteral<"ok">;
  members: z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    device: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>>;
}, z.core.$catchall<z.ZodUnknown>>>;
declare const roomNoticeSchema: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
  "1": z.ZodOptional<z.ZodNumber>;
  "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
}, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>;
declare const roomNoticeClaimsSchema: z.ZodLazy<z.ZodObject<{
  room: z.ZodLazy<z.ZodLazy<z.ZodUnion<readonly [z.ZodLazy<z.ZodLazy<z.ZodString>>, z.ZodLazy<z.ZodLazy<z.ZodString>>]>>>;
  poster: z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>;
  "poster-key": z.ZodLazy<z.ZodLazy<z.ZodObject<{
    alg: z.ZodNumber;
    "public-key": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  }, z.core.$strip>>>;
  token: z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodLazy<z.ZodTuple<[z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodLazy<z.ZodLazy<z.ZodObject<{
    "1": z.ZodOptional<z.ZodNumber>;
    "4": z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
  }, z.core.$catchall<z.ZodUnknown>>>>, z.ZodUnion<readonly [z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, z.ZodNull]>, z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>], null>>>>>;
  "notice-id": z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  "posted-at": z.ZodNumber;
  "content-type": z.ZodString;
  content: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
  refs: z.ZodOptional<z.ZodArray<z.ZodLazy<z.ZodLazy<z.ZodObject<{
    id: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
    relation: z.ZodString;
  }, z.core.$strip>>>>>;
}, z.core.$catchall<z.ZodUnknown>>>;
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
  "delegations-remaining": z.ZodOptional<z.ZodNumber>;
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
  "to-device": z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>>;
  "from-device": z.ZodOptional<z.ZodLazy<z.ZodLazy<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>>>;
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
type RoomPath = z.infer<typeof roomPathSchema>;
type DeviceIdHex = z.infer<typeof deviceIdHexSchema>;
type OwnerNamedRoomPath = z.infer<typeof ownerNamedRoomPathSchema>;
type DmRoomPath = z.infer<typeof dmRoomPathSchema>;
type RoomSend = z.infer<typeof roomSendSchema>;
type RoomRead = z.infer<typeof roomReadSchema>;
type RoomLeave = z.infer<typeof roomLeaveSchema>;
type RoomMembers = z.infer<typeof roomMembersSchema>;
type MessageRef = z.infer<typeof messageRefSchema>;
type RoomJoin = z.infer<typeof roomJoinSchema>;
type RoomInvite = z.infer<typeof roomInviteSchema>;
type RoomMember = z.infer<typeof roomMemberSchema>;
type RoomJoinOk = z.infer<typeof roomJoinOkSchema>;
type RoomMembersOk = z.infer<typeof roomMembersOkSchema>;
type RoomNotice = z.infer<typeof roomNoticeSchema>;
type RoomNoticeClaims = z.infer<typeof roomNoticeClaimsSchema>;
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
export { PtyResize as $, streamEndFrameSchema as $n, execSessionInfoSchema as $t, IceCandidateInit as A, ptySpawnSchema as An, WireCandidate as At, NamespacedDomainId as B, roomJoinOkSchema as Bn, coseHeaderAlgSchema as Bt, ExecSessionInfo as C, privateUseDomainIdSchema as Cn, StreamEndFrame as Ct, HandleClaims as D, protocolVersionSchema as Dn, WebrtcAnswer as Dt, GossipFrame as E, procSpawnSchema as En, TokenClaims as Et, ManageOk as F, relayOfferFrameSchema as Fn, capabilityVerbSchema as Ft, PingFrame as G, roomMembersSchema as Gn, dataEntriesFrameSchema as Gt, OwnerNamedRoomPath as H, roomLeaveSchema as Hn, coseHeaderLabelSchema as Ht, ManageRequestFrame as I, revocationAnnounceFrameSchema as In, closeFrameSchema as It, ProcKill as J, roomPathSchema as Jn, deviceIdHexSchema as Jt, PrivateUseCapability as K, roomNoticeClaimsSchema as Kn, dataHaveFrameSchema as Kt, ManageResponseFrame as L, revocationClaimsSchema as Ln, coordinatorFrameSchema as Lt, ManageCommand as M, relayConnectFrameSchema as Mn, candidatesFrameSchema as Mt, ManageCommandParams as N, relayDataFrameSchema as Nn, capabilityScopeSchema as Nt, HandleRecord as O, ptyKillSchema as On, WebrtcIceCandidate as Ot, ManageError as P, relayInboundFrameSchema as Pn, capabilityTokenSchema as Pt, PtyKill as Q, streamDataFrameSchema as Qn, execListSchema as Qt, MessageRef as R, revocationEntrySchema as Rn, coreCapabilitySchema as Rt, ExecList as S, privateUseCapabilitySchema as Sn, StreamDataFrame as St, FrameVariant as T, procSignalSchema as Tn, SyncPunchFrame as Tt, PeerAdvert as U, roomMemberSchema as Un, coseSign1Schema as Ut, ObservedAddressFrame as V, roomJoinSchema as Vn, coseHeaderKidSchema as Vt, PeerIdentity as W, roomMembersOkSchema as Wn, coseTokenHeadersSchema as Wt, ProcSpawn as X, roomSendSchema as Xn, dmRoomPathSchema as Xt, ProcSignal as Y, roomReadSchema as Yn, deviceIdSchema as Yt, ProtocolVersion as Z, streamAckFrameSchema as Zn, domainIdSchema as Zt, DataRequestFrame as _, observedAddressFrameSchema as _n, RoomNoticeClaims as _t, CapabilityVerb as a, handshakeFrameSchema as an, webrtcOfferSchema as ar, RelayOfferFrame as at, DmRoomPath as b, peerIdentitySchema as bn, RoomSend as bt, CoreCapability as c, manageCommandParamsSchema as cn, RevocationEntry as ct, CoseHeaderKid as d, manageOkSchema as dn, RoomJoinOk as dt, frameSchema as en, streamSessionSchema as er, PtySpawn as et, CoseHeaderLabel as f, manageRequestFrameSchema as fn, RoomLeave as ft, DataHaveFrame as g, namespacedDomainIdSchema as gn, RoomNotice as gt, DataEntriesFrame as h, namespacedCapabilitySchema as hn, RoomMembersOk as ht, CapabilityToken as i, handleRecordSchema as in, webrtcIceCandidateSchema as ir, RelayInboundFrame as it, IdentityKey as j, ptyWriteSchema as jn, candidateKindSchema as jt, HandshakeFrame as k, ptyResizeSchema as kn, WebrtcOffer as kt, CoreDomainName as l, manageCommandSchema as ln, RoomInvite as lt, CoseTokenHeaders as m, messageRefSchema as mn, RoomMembers as mt, CandidatesFrame as n, gossipFrameSchema as nn, tokenClaimsSchema as nr, RelayConnectFrame as nt, CloseFrame as o, iceCandidateInitSchema as on, wireCandidateSchema as or, RevocationAnnounceFrame as ot, CoseSign1 as p, manageResponseFrameSchema as pn, RoomMember as pt, PrivateUseDomainId as q, roomNoticeSchema as qn, dataRequestFrameSchema as qt, CapabilityScope as r, handleClaimsSchema as rn, webrtcAnswerSchema as rr, RelayDataFrame as rt, CoordinatorFrame as s, identityKeySchema as sn, RevocationClaims as st, CandidateKind as t, frameVariantSchema as tn, syncPunchFrameSchema as tr, PtyWrite as tt, CoseHeaderAlg as u, manageErrorSchema as un, RoomJoin as ut, DeviceId as v, ownerNamedRoomPathSchema as vn, RoomPath as vt, Frame as w, procKillSchema as wn, StreamSession as wt, DomainId as x, pingFrameSchema as xn, StreamAckFrame as xt, DeviceIdHex as y, peerAdvertSchema as yn, RoomRead as yt, NamespacedCapability as z, roomInviteSchema as zn, coreDomainNameSchema as zt };