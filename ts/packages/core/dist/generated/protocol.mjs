import { z } from "zod";
//#region src/generated/protocol.ts
const dataHaveFrameSchema = z.lazy(() => z.object({
	"type": z.literal("data-have"),
	"peer": z.lazy(() => deviceIdSchema),
	"head-seq": z.number().int().nonnegative()
}));
const dataRequestFrameSchema = z.lazy(() => z.object({
	"type": z.literal("data-request"),
	"peer": z.lazy(() => deviceIdSchema),
	"from-seq": z.number().int().nonnegative()
}));
const dataEntriesFrameSchema = z.lazy(() => z.object({
	"type": z.literal("data-entries"),
	"peer": z.lazy(() => deviceIdSchema),
	"from-seq": z.number().int().nonnegative(),
	"entries": z.array(z.instanceof(Uint8Array))
}));
const handleClaimsSchema = z.lazy(() => z.object({
	"handle": z.string(),
	"device-id": z.lazy(() => deviceIdSchema),
	"identity-key": z.lazy(() => identityKeySchema),
	"candidates": z.array(z.lazy(() => wireCandidateSchema)).optional(),
	"mailboxes": z.array(z.lazy(() => deviceIdSchema)).optional(),
	"issued": z.number().int().nonnegative(),
	"expires": z.number().int().nonnegative()
}));
const handleRecordSchema = z.lazy(() => z.lazy(() => coseSign1Schema));
const manageCommandParamsSchema = z.lazy(() => z.union([z.union([
	z.lazy(() => ptySpawnSchema),
	z.lazy(() => ptyWriteSchema),
	z.lazy(() => ptyResizeSchema),
	z.lazy(() => ptyKillSchema),
	z.lazy(() => procSpawnSchema),
	z.lazy(() => procSignalSchema),
	z.lazy(() => procKillSchema),
	z.lazy(() => execListSchema)
]), z.object({}).catchall(z.unknown())]));
const ptySpawnSchema = z.lazy(() => z.object({
	"verb": z.literal("pty.spawn"),
	"shell": z.string().optional(),
	"argv": z.array(z.string()),
	"cwd": z.string().optional(),
	"env": z.object({}).catchall(z.string()),
	"cols": z.number().int().nonnegative(),
	"rows": z.number().int().nonnegative()
}));
const ptyWriteSchema = z.lazy(() => z.object({
	"verb": z.literal("pty.write"),
	"session": z.lazy(() => streamSessionSchema),
	"bytes": z.instanceof(Uint8Array)
}));
const ptyResizeSchema = z.lazy(() => z.object({
	"verb": z.literal("pty.resize"),
	"session": z.lazy(() => streamSessionSchema),
	"cols": z.number().int().nonnegative(),
	"rows": z.number().int().nonnegative()
}));
const ptyKillSchema = z.lazy(() => z.object({
	"verb": z.literal("pty.kill"),
	"session": z.lazy(() => streamSessionSchema),
	"signal": z.number().int()
}));
const procSpawnSchema = z.lazy(() => z.object({
	"verb": z.literal("proc.spawn"),
	"argv": z.array(z.string()),
	"cwd": z.string().optional(),
	"env": z.object({}).catchall(z.string())
}));
const procSignalSchema = z.lazy(() => z.object({
	"verb": z.literal("proc.signal"),
	"session": z.lazy(() => streamSessionSchema),
	"signal": z.number().int()
}));
const procKillSchema = z.lazy(() => z.object({
	"verb": z.literal("proc.kill"),
	"session": z.lazy(() => streamSessionSchema)
}));
const execListSchema = z.lazy(() => z.object({ "verb": z.literal("exec.list") }));
const execSessionInfoSchema = z.lazy(() => z.object({
	"session": z.lazy(() => streamSessionSchema),
	"kind": z.union([z.literal("pty"), z.literal("proc")]),
	"argv": z.array(z.string()).optional(),
	"cwd": z.string().optional()
}));
const frameVariantSchema = z.lazy(() => z.union([
	z.lazy(() => handshakeFrameSchema),
	z.lazy(() => pingFrameSchema),
	z.lazy(() => closeFrameSchema),
	z.lazy(() => gossipFrameSchema),
	z.lazy(() => candidatesFrameSchema),
	z.lazy(() => syncPunchFrameSchema),
	z.lazy(() => observedAddressFrameSchema),
	z.lazy(() => relayOfferFrameSchema),
	z.lazy(() => relayConnectFrameSchema),
	z.lazy(() => relayDataFrameSchema),
	z.lazy(() => relayInboundFrameSchema),
	z.lazy(() => coordinatorFrameSchema),
	z.lazy(() => manageRequestFrameSchema),
	z.lazy(() => manageResponseFrameSchema),
	z.lazy(() => revocationAnnounceFrameSchema),
	z.lazy(() => streamDataFrameSchema),
	z.lazy(() => streamAckFrameSchema),
	z.lazy(() => streamEndFrameSchema),
	z.lazy(() => dataHaveFrameSchema),
	z.lazy(() => dataRequestFrameSchema),
	z.lazy(() => dataEntriesFrameSchema)
]));
const frameSchema = z.lazy(() => z.lazy(() => frameVariantSchema));
const protocolVersionSchema = z.lazy(() => z.number().int().nonnegative());
const domainIdSchema = z.lazy(() => z.union([
	z.lazy(() => coreDomainNameSchema),
	z.lazy(() => namespacedDomainIdSchema),
	z.lazy(() => privateUseDomainIdSchema)
]));
const coreDomainNameSchema = z.lazy(() => z.union([
	z.literal("core/management"),
	z.literal("core/exec"),
	z.literal("core/data"),
	z.literal("core/federation")
]));
const namespacedDomainIdSchema = z.lazy(() => z.string().regex(/* @__PURE__ */ new RegExp("[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/[A-Za-z0-9_.-]+")));
const privateUseDomainIdSchema = z.lazy(() => z.string().regex(/* @__PURE__ */ new RegExp("x-[A-Za-z0-9_.-]+")));
const handshakeFrameSchema = z.lazy(() => z.object({
	"type": z.literal("handshake"),
	"version": z.lazy(() => protocolVersionSchema),
	"domains": z.array(z.lazy(() => domainIdSchema)),
	"params": z.object({}).catchall(z.unknown()).optional()
}));
const identityKeySchema = z.lazy(() => z.object({
	"alg": z.number().int(),
	"public-key": z.instanceof(Uint8Array)
}));
const deviceIdSchema = z.lazy(() => z.instanceof(Uint8Array).refine((v) => v.length === 32, { message: "expected exactly 32 bytes" }));
const peerIdentitySchema = z.lazy(() => z.object({
	"device-id": z.lazy(() => deviceIdSchema),
	"identity-key": z.lazy(() => identityKeySchema),
	"certificate": z.instanceof(Uint8Array).optional()
}));
const manageCommandSchema = z.lazy(() => z.object({
	"verb": z.lazy(() => capabilityVerbSchema),
	"params": z.lazy(() => manageCommandParamsSchema)
}));
const manageRequestFrameSchema = z.lazy(() => z.object({
	"type": z.literal("manage-request"),
	"request-id": z.number().int().nonnegative(),
	"command": z.lazy(() => manageCommandSchema),
	"scope": z.lazy(() => capabilityScopeSchema),
	"token": z.lazy(() => capabilityTokenSchema).optional()
}));
const manageOkSchema = z.lazy(() => z.object({ "result": z.literal("ok") }).catchall(z.unknown()));
const manageErrorSchema = z.lazy(() => z.object({
	"result": z.literal("error"),
	"code": z.string(),
	"message": z.string().optional()
}));
const manageResponseFrameSchema = z.lazy(() => z.object({
	"type": z.literal("manage-response"),
	"request-id": z.number().int().nonnegative(),
	"outcome": z.union([z.lazy(() => manageOkSchema), z.lazy(() => manageErrorSchema)])
}));
const revocationClaimsSchema = z.lazy(() => z.object({
	"token-id": z.instanceof(Uint8Array),
	"issuer": z.lazy(() => deviceIdSchema),
	"issuer-key": z.lazy(() => identityKeySchema),
	"revoked-at": z.number().int().nonnegative()
}));
const revocationEntrySchema = z.lazy(() => z.lazy(() => coseSign1Schema));
const revocationAnnounceFrameSchema = z.lazy(() => z.object({
	"type": z.literal("revocation-announce"),
	"entries": z.array(z.lazy(() => revocationEntrySchema))
}));
const streamSessionSchema = z.lazy(() => z.number().int().nonnegative());
const streamDataFrameSchema = z.lazy(() => z.object({
	"type": z.literal("stream-data"),
	"session": z.lazy(() => streamSessionSchema),
	"seq": z.number().int().nonnegative(),
	"channel": z.string(),
	"bytes": z.instanceof(Uint8Array)
}));
const streamAckFrameSchema = z.lazy(() => z.object({
	"type": z.literal("stream-ack"),
	"session": z.lazy(() => streamSessionSchema),
	"ack-seq": z.number().int().nonnegative(),
	"window": z.number().int().nonnegative()
}));
const streamEndFrameSchema = z.lazy(() => z.object({
	"type": z.literal("stream-end"),
	"session": z.lazy(() => streamSessionSchema),
	"exit-code": z.number().int().optional(),
	"exit-signal": z.number().int().optional()
}));
const capabilityVerbSchema = z.lazy(() => z.union([
	z.lazy(() => coreCapabilitySchema),
	z.lazy(() => namespacedCapabilitySchema),
	z.lazy(() => privateUseCapabilitySchema)
]));
const coreCapabilitySchema = z.lazy(() => z.string().regex(/* @__PURE__ */ new RegExp("[a-z][a-z0-9-]*:[a-z][a-z0-9-]*")));
const namespacedCapabilitySchema = z.lazy(() => z.string().regex(/* @__PURE__ */ new RegExp("[a-z0-9.-]+/[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+")));
const privateUseCapabilitySchema = z.lazy(() => z.string().regex(/* @__PURE__ */ new RegExp("x-[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+")));
const capabilityScopeSchema = z.lazy(() => z.object({
	"kind": z.string(),
	"path": z.string().optional()
}));
const coseHeaderAlgSchema = z.lazy(() => z.literal(1));
const coseHeaderKidSchema = z.lazy(() => z.literal(4));
const coseHeaderLabelSchema = z.lazy(() => z.union([z.number().int(), z.string()]));
const coseTokenHeadersSchema = z.lazy(() => z.object({
	"1": z.number().int().optional(),
	"4": z.instanceof(Uint8Array).optional()
}).catchall(z.unknown()));
const coseSign1Schema = z.lazy(() => z.tuple([
	z.instanceof(Uint8Array),
	z.lazy(() => coseTokenHeadersSchema),
	z.union([z.instanceof(Uint8Array), z.null()]),
	z.instanceof(Uint8Array)
]));
const capabilityTokenSchema = z.lazy(() => z.lazy(() => coseSign1Schema));
const tokenClaimsSchema = z.lazy(() => z.object({
	"token-id": z.instanceof(Uint8Array),
	"issuer": z.lazy(() => deviceIdSchema),
	"issuer-key": z.lazy(() => identityKeySchema),
	"bearer": z.lazy(() => deviceIdSchema),
	"capability": z.lazy(() => capabilityVerbSchema),
	"scope": z.lazy(() => capabilityScopeSchema),
	"expires": z.number().int().nonnegative(),
	"not-before": z.number().int().nonnegative().optional(),
	"parent": z.instanceof(Uint8Array).optional()
}).catchall(z.unknown()));
const pingFrameSchema = z.lazy(() => z.object({ "type": z.literal("ping") }));
const closeFrameSchema = z.lazy(() => z.object({
	"type": z.literal("close"),
	"reason": z.string().optional()
}));
const peerAdvertSchema = z.lazy(() => z.object({
	"device": z.lazy(() => deviceIdSchema),
	"addresses": z.array(z.string()),
	"snapshot-seconds": z.number().int()
}));
const gossipFrameSchema = z.lazy(() => z.object({
	"type": z.literal("gossip"),
	"peers": z.array(z.lazy(() => peerAdvertSchema))
}));
const candidateKindSchema = z.lazy(() => z.union([
	z.literal("host"),
	z.literal("server-reflexive"),
	z.literal("relayed")
]));
const wireCandidateSchema = z.lazy(() => z.object({
	"address": z.string(),
	"kind": z.lazy(() => candidateKindSchema),
	"priority": z.number().int().nonnegative()
}));
const candidatesFrameSchema = z.lazy(() => z.object({
	"type": z.literal("candidates"),
	"candidates": z.array(z.lazy(() => wireCandidateSchema))
}));
const syncPunchFrameSchema = z.lazy(() => z.object({
	"type": z.literal("sync-punch"),
	"nonce": z.number().int().nonnegative(),
	"deadline-unix-ms": z.number().int().nonnegative()
}));
const observedAddressFrameSchema = z.lazy(() => z.object({
	"type": z.literal("observed-address"),
	"address": z.string()
}));
const relayOfferFrameSchema = z.lazy(() => z.object({
	"type": z.literal("relay-offer"),
	"addresses": z.array(z.string())
}));
const relayConnectFrameSchema = z.lazy(() => z.object({
	"type": z.literal("relay-connect"),
	"target-device": z.lazy(() => deviceIdSchema)
}));
const relayDataFrameSchema = z.lazy(() => z.object({
	"type": z.literal("relay-data"),
	"payload": z.instanceof(Uint8Array)
}));
const relayInboundFrameSchema = z.lazy(() => z.object({
	"type": z.literal("relay-inbound"),
	"source-device": z.lazy(() => deviceIdSchema)
}));
const coordinatorFrameSchema = z.lazy(() => z.object({
	"type": z.literal("coordinator"),
	"term": z.number().int().nonnegative(),
	"coordinator": z.lazy(() => deviceIdSchema),
	"capacity-hint": z.number().int().nonnegative().optional()
}));
//#endregion
export { candidateKindSchema, candidatesFrameSchema, capabilityScopeSchema, capabilityTokenSchema, capabilityVerbSchema, closeFrameSchema, coordinatorFrameSchema, coreCapabilitySchema, coreDomainNameSchema, coseHeaderAlgSchema, coseHeaderKidSchema, coseHeaderLabelSchema, coseSign1Schema, coseTokenHeadersSchema, dataEntriesFrameSchema, dataHaveFrameSchema, dataRequestFrameSchema, deviceIdSchema, domainIdSchema, execListSchema, execSessionInfoSchema, frameSchema, frameVariantSchema, gossipFrameSchema, handleClaimsSchema, handleRecordSchema, handshakeFrameSchema, identityKeySchema, manageCommandParamsSchema, manageCommandSchema, manageErrorSchema, manageOkSchema, manageRequestFrameSchema, manageResponseFrameSchema, namespacedCapabilitySchema, namespacedDomainIdSchema, observedAddressFrameSchema, peerAdvertSchema, peerIdentitySchema, pingFrameSchema, privateUseCapabilitySchema, privateUseDomainIdSchema, procKillSchema, procSignalSchema, procSpawnSchema, protocolVersionSchema, ptyKillSchema, ptyResizeSchema, ptySpawnSchema, ptyWriteSchema, relayConnectFrameSchema, relayDataFrameSchema, relayInboundFrameSchema, relayOfferFrameSchema, revocationAnnounceFrameSchema, revocationClaimsSchema, revocationEntrySchema, streamAckFrameSchema, streamDataFrameSchema, streamEndFrameSchema, streamSessionSchema, syncPunchFrameSchema, tokenClaimsSchema, wireCandidateSchema };
