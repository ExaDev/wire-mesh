Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let zod = require("zod");
//#region src/generated/protocol.ts
const dataHaveFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("data-have"),
	"peer": zod.z.lazy(() => deviceIdSchema),
	"head-seq": zod.z.number().int().nonnegative()
}));
const dataRequestFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("data-request"),
	"peer": zod.z.lazy(() => deviceIdSchema),
	"from-seq": zod.z.number().int().nonnegative()
}));
const dataEntriesFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("data-entries"),
	"peer": zod.z.lazy(() => deviceIdSchema),
	"from-seq": zod.z.number().int().nonnegative(),
	"entries": zod.z.array(zod.z.instanceof(Uint8Array))
}));
const handleClaimsSchema = zod.z.lazy(() => zod.z.object({
	"handle": zod.z.string(),
	"device-id": zod.z.lazy(() => deviceIdSchema),
	"identity-key": zod.z.lazy(() => identityKeySchema),
	"candidates": zod.z.array(zod.z.lazy(() => wireCandidateSchema)).optional(),
	"mailboxes": zod.z.array(zod.z.lazy(() => deviceIdSchema)).optional(),
	"issued": zod.z.number().int().nonnegative(),
	"expires": zod.z.number().int().nonnegative()
}));
const handleRecordSchema = zod.z.lazy(() => zod.z.lazy(() => coseSign1Schema));
const manageCommandParamsSchema = zod.z.lazy(() => zod.z.union([
	zod.z.union([
		zod.z.lazy(() => ptySpawnSchema),
		zod.z.lazy(() => ptyWriteSchema),
		zod.z.lazy(() => ptyResizeSchema),
		zod.z.lazy(() => ptyKillSchema),
		zod.z.lazy(() => procSpawnSchema),
		zod.z.lazy(() => procSignalSchema),
		zod.z.lazy(() => procKillSchema),
		zod.z.lazy(() => execListSchema)
	]),
	zod.z.object({}).catchall(zod.z.unknown()),
	zod.z.union([
		zod.z.lazy(() => webrtcOfferSchema),
		zod.z.lazy(() => webrtcAnswerSchema),
		zod.z.lazy(() => webrtcIceCandidateSchema)
	])
]));
const ptySpawnSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.literal("pty.spawn"),
	"shell": zod.z.string().optional(),
	"argv": zod.z.array(zod.z.string()),
	"cwd": zod.z.string().optional(),
	"env": zod.z.object({}).catchall(zod.z.string()),
	"cols": zod.z.number().int().nonnegative(),
	"rows": zod.z.number().int().nonnegative()
}));
const ptyWriteSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.literal("pty.write"),
	"session": zod.z.lazy(() => streamSessionSchema),
	"bytes": zod.z.instanceof(Uint8Array)
}));
const ptyResizeSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.literal("pty.resize"),
	"session": zod.z.lazy(() => streamSessionSchema),
	"cols": zod.z.number().int().nonnegative(),
	"rows": zod.z.number().int().nonnegative()
}));
const ptyKillSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.literal("pty.kill"),
	"session": zod.z.lazy(() => streamSessionSchema),
	"signal": zod.z.number().int()
}));
const procSpawnSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.literal("proc.spawn"),
	"argv": zod.z.array(zod.z.string()),
	"cwd": zod.z.string().optional(),
	"env": zod.z.object({}).catchall(zod.z.string())
}));
const procSignalSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.literal("proc.signal"),
	"session": zod.z.lazy(() => streamSessionSchema),
	"signal": zod.z.number().int()
}));
const procKillSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.literal("proc.kill"),
	"session": zod.z.lazy(() => streamSessionSchema)
}));
const execListSchema = zod.z.lazy(() => zod.z.object({ "verb": zod.z.literal("exec.list") }));
const execSessionInfoSchema = zod.z.lazy(() => zod.z.object({
	"session": zod.z.lazy(() => streamSessionSchema),
	"kind": zod.z.union([zod.z.literal("pty"), zod.z.literal("proc")]),
	"argv": zod.z.array(zod.z.string()).optional(),
	"cwd": zod.z.string().optional()
}));
const frameVariantSchema = zod.z.lazy(() => zod.z.union([
	zod.z.lazy(() => handshakeFrameSchema),
	zod.z.lazy(() => pingFrameSchema),
	zod.z.lazy(() => closeFrameSchema),
	zod.z.lazy(() => gossipFrameSchema),
	zod.z.lazy(() => candidatesFrameSchema),
	zod.z.lazy(() => syncPunchFrameSchema),
	zod.z.lazy(() => observedAddressFrameSchema),
	zod.z.lazy(() => relayOfferFrameSchema),
	zod.z.lazy(() => relayConnectFrameSchema),
	zod.z.lazy(() => relayDataFrameSchema),
	zod.z.lazy(() => relayInboundFrameSchema),
	zod.z.lazy(() => coordinatorFrameSchema),
	zod.z.lazy(() => manageRequestFrameSchema),
	zod.z.lazy(() => manageResponseFrameSchema),
	zod.z.lazy(() => revocationAnnounceFrameSchema),
	zod.z.lazy(() => streamDataFrameSchema),
	zod.z.lazy(() => streamAckFrameSchema),
	zod.z.lazy(() => streamEndFrameSchema),
	zod.z.lazy(() => dataHaveFrameSchema),
	zod.z.lazy(() => dataRequestFrameSchema),
	zod.z.lazy(() => dataEntriesFrameSchema)
]));
const frameSchema = zod.z.lazy(() => zod.z.lazy(() => frameVariantSchema));
const protocolVersionSchema = zod.z.lazy(() => zod.z.number().int().nonnegative());
const domainIdSchema = zod.z.lazy(() => zod.z.union([
	zod.z.lazy(() => coreDomainNameSchema),
	zod.z.lazy(() => namespacedDomainIdSchema),
	zod.z.lazy(() => privateUseDomainIdSchema)
]));
const coreDomainNameSchema = zod.z.lazy(() => zod.z.union([
	zod.z.literal("core/management"),
	zod.z.literal("core/exec"),
	zod.z.literal("core/data"),
	zod.z.literal("core/federation"),
	zod.z.literal("core/webrtc")
]));
const namespacedDomainIdSchema = zod.z.lazy(() => zod.z.string().regex(/* @__PURE__ */ new RegExp("[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/[A-Za-z0-9_.-]+")));
const privateUseDomainIdSchema = zod.z.lazy(() => zod.z.string().regex(/* @__PURE__ */ new RegExp("x-[A-Za-z0-9_.-]+")));
const handshakeFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("handshake"),
	"version": zod.z.lazy(() => protocolVersionSchema),
	"domains": zod.z.array(zod.z.lazy(() => domainIdSchema)),
	"params": zod.z.object({}).catchall(zod.z.unknown()).optional()
}));
const identityKeySchema = zod.z.lazy(() => zod.z.object({
	"alg": zod.z.number().int(),
	"public-key": zod.z.instanceof(Uint8Array)
}));
const deviceIdSchema = zod.z.lazy(() => zod.z.instanceof(Uint8Array).refine((v) => v.length === 32, { message: "expected exactly 32 bytes" }));
const peerIdentitySchema = zod.z.lazy(() => zod.z.object({
	"device-id": zod.z.lazy(() => deviceIdSchema),
	"identity-key": zod.z.lazy(() => identityKeySchema),
	"certificate": zod.z.instanceof(Uint8Array).optional()
}));
const manageCommandSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.lazy(() => capabilityVerbSchema),
	"params": zod.z.lazy(() => manageCommandParamsSchema)
}));
const manageRequestFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("manage-request"),
	"request-id": zod.z.number().int().nonnegative(),
	"command": zod.z.lazy(() => manageCommandSchema),
	"scope": zod.z.lazy(() => capabilityScopeSchema),
	"token": zod.z.lazy(() => capabilityTokenSchema).optional()
}));
const manageOkSchema = zod.z.lazy(() => zod.z.object({ "result": zod.z.literal("ok") }).catchall(zod.z.unknown()));
const manageErrorSchema = zod.z.lazy(() => zod.z.object({
	"result": zod.z.literal("error"),
	"code": zod.z.string(),
	"message": zod.z.string().optional()
}));
const manageResponseFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("manage-response"),
	"request-id": zod.z.number().int().nonnegative(),
	"outcome": zod.z.union([zod.z.lazy(() => manageOkSchema), zod.z.lazy(() => manageErrorSchema)])
}));
const revocationClaimsSchema = zod.z.lazy(() => zod.z.object({
	"token-id": zod.z.instanceof(Uint8Array),
	"issuer": zod.z.lazy(() => deviceIdSchema),
	"issuer-key": zod.z.lazy(() => identityKeySchema),
	"revoked-at": zod.z.number().int().nonnegative()
}));
const revocationEntrySchema = zod.z.lazy(() => zod.z.lazy(() => coseSign1Schema));
const revocationAnnounceFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("revocation-announce"),
	"entries": zod.z.array(zod.z.lazy(() => revocationEntrySchema))
}));
const streamSessionSchema = zod.z.lazy(() => zod.z.number().int().nonnegative());
const streamDataFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("stream-data"),
	"session": zod.z.lazy(() => streamSessionSchema),
	"seq": zod.z.number().int().nonnegative(),
	"channel": zod.z.string(),
	"bytes": zod.z.instanceof(Uint8Array)
}));
const streamAckFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("stream-ack"),
	"session": zod.z.lazy(() => streamSessionSchema),
	"ack-seq": zod.z.number().int().nonnegative(),
	"window": zod.z.number().int().nonnegative()
}));
const streamEndFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("stream-end"),
	"session": zod.z.lazy(() => streamSessionSchema),
	"exit-code": zod.z.number().int().optional(),
	"exit-signal": zod.z.number().int().optional()
}));
const capabilityVerbSchema = zod.z.lazy(() => zod.z.union([
	zod.z.lazy(() => coreCapabilitySchema),
	zod.z.lazy(() => namespacedCapabilitySchema),
	zod.z.lazy(() => privateUseCapabilitySchema)
]));
const coreCapabilitySchema = zod.z.lazy(() => zod.z.string().regex(/* @__PURE__ */ new RegExp("[a-z][a-z0-9-]*:[a-z][a-z0-9-]*")));
const namespacedCapabilitySchema = zod.z.lazy(() => zod.z.string().regex(/* @__PURE__ */ new RegExp("[a-z0-9.-]+/[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+")));
const privateUseCapabilitySchema = zod.z.lazy(() => zod.z.string().regex(/* @__PURE__ */ new RegExp("x-[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+")));
const capabilityScopeSchema = zod.z.lazy(() => zod.z.object({
	"kind": zod.z.string(),
	"path": zod.z.string().optional()
}));
const coseHeaderAlgSchema = zod.z.lazy(() => zod.z.literal(1));
const coseHeaderKidSchema = zod.z.lazy(() => zod.z.literal(4));
const coseHeaderLabelSchema = zod.z.lazy(() => zod.z.union([zod.z.number().int(), zod.z.string()]));
const coseTokenHeadersSchema = zod.z.lazy(() => zod.z.object({
	"1": zod.z.number().int().optional(),
	"4": zod.z.instanceof(Uint8Array).optional()
}).catchall(zod.z.unknown()));
const coseSign1Schema = zod.z.lazy(() => zod.z.tuple([
	zod.z.instanceof(Uint8Array),
	zod.z.lazy(() => coseTokenHeadersSchema),
	zod.z.union([zod.z.instanceof(Uint8Array), zod.z.null()]),
	zod.z.instanceof(Uint8Array)
]));
const capabilityTokenSchema = zod.z.lazy(() => zod.z.lazy(() => coseSign1Schema));
const tokenClaimsSchema = zod.z.lazy(() => zod.z.object({
	"token-id": zod.z.instanceof(Uint8Array),
	"issuer": zod.z.lazy(() => deviceIdSchema),
	"issuer-key": zod.z.lazy(() => identityKeySchema),
	"bearer": zod.z.lazy(() => deviceIdSchema),
	"capability": zod.z.lazy(() => capabilityVerbSchema),
	"scope": zod.z.lazy(() => capabilityScopeSchema),
	"expires": zod.z.number().int().nonnegative(),
	"not-before": zod.z.number().int().nonnegative().optional(),
	"parent": zod.z.instanceof(Uint8Array).optional()
}).catchall(zod.z.unknown()));
const pingFrameSchema = zod.z.lazy(() => zod.z.object({ "type": zod.z.literal("ping") }));
const closeFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("close"),
	"reason": zod.z.string().optional()
}));
const peerAdvertSchema = zod.z.lazy(() => zod.z.object({
	"device": zod.z.lazy(() => deviceIdSchema),
	"addresses": zod.z.array(zod.z.string()),
	"snapshot-seconds": zod.z.number().int()
}));
const gossipFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("gossip"),
	"peers": zod.z.array(zod.z.lazy(() => peerAdvertSchema))
}));
const candidateKindSchema = zod.z.lazy(() => zod.z.union([
	zod.z.literal("host"),
	zod.z.literal("server-reflexive"),
	zod.z.literal("relayed")
]));
const wireCandidateSchema = zod.z.lazy(() => zod.z.object({
	"address": zod.z.string(),
	"kind": zod.z.lazy(() => candidateKindSchema),
	"priority": zod.z.number().int().nonnegative()
}));
const candidatesFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("candidates"),
	"candidates": zod.z.array(zod.z.lazy(() => wireCandidateSchema))
}));
const syncPunchFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("sync-punch"),
	"nonce": zod.z.number().int().nonnegative(),
	"deadline-unix-ms": zod.z.number().int().nonnegative()
}));
const observedAddressFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("observed-address"),
	"address": zod.z.string()
}));
const relayOfferFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("relay-offer"),
	"addresses": zod.z.array(zod.z.string())
}));
const relayConnectFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("relay-connect"),
	"target-device": zod.z.lazy(() => deviceIdSchema),
	"direct-only": zod.z.boolean().optional()
}));
const relayDataFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("relay-data"),
	"payload": zod.z.instanceof(Uint8Array),
	"to-device": zod.z.lazy(() => deviceIdSchema).optional(),
	"from-device": zod.z.lazy(() => deviceIdSchema).optional()
}));
const relayInboundFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("relay-inbound"),
	"source-device": zod.z.lazy(() => deviceIdSchema)
}));
const coordinatorFrameSchema = zod.z.lazy(() => zod.z.object({
	"type": zod.z.literal("coordinator"),
	"term": zod.z.number().int().nonnegative(),
	"coordinator": zod.z.lazy(() => deviceIdSchema),
	"capacity-hint": zod.z.number().int().nonnegative().optional()
}));
const webrtcOfferSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.literal("webrtc.offer"),
	"negotiation-id": zod.z.number().int().nonnegative(),
	"sdp": zod.z.string()
}));
const webrtcAnswerSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.literal("webrtc.answer"),
	"negotiation-id": zod.z.number().int().nonnegative(),
	"sdp": zod.z.string()
}));
const webrtcIceCandidateSchema = zod.z.lazy(() => zod.z.object({
	"verb": zod.z.literal("webrtc.ice-candidate"),
	"negotiation-id": zod.z.number().int().nonnegative(),
	"candidate": zod.z.lazy(() => iceCandidateInitSchema).optional()
}));
const iceCandidateInitSchema = zod.z.lazy(() => zod.z.object({
	"candidate": zod.z.string(),
	"sdp-mid": zod.z.string().optional(),
	"sdp-m-line-index": zod.z.number().int().nonnegative().optional(),
	"username-fragment": zod.z.string().optional()
}));
//#endregion
exports.candidateKindSchema = candidateKindSchema;
exports.candidatesFrameSchema = candidatesFrameSchema;
exports.capabilityScopeSchema = capabilityScopeSchema;
exports.capabilityTokenSchema = capabilityTokenSchema;
exports.capabilityVerbSchema = capabilityVerbSchema;
exports.closeFrameSchema = closeFrameSchema;
exports.coordinatorFrameSchema = coordinatorFrameSchema;
exports.coreCapabilitySchema = coreCapabilitySchema;
exports.coreDomainNameSchema = coreDomainNameSchema;
exports.coseHeaderAlgSchema = coseHeaderAlgSchema;
exports.coseHeaderKidSchema = coseHeaderKidSchema;
exports.coseHeaderLabelSchema = coseHeaderLabelSchema;
exports.coseSign1Schema = coseSign1Schema;
exports.coseTokenHeadersSchema = coseTokenHeadersSchema;
exports.dataEntriesFrameSchema = dataEntriesFrameSchema;
exports.dataHaveFrameSchema = dataHaveFrameSchema;
exports.dataRequestFrameSchema = dataRequestFrameSchema;
exports.deviceIdSchema = deviceIdSchema;
exports.domainIdSchema = domainIdSchema;
exports.execListSchema = execListSchema;
exports.execSessionInfoSchema = execSessionInfoSchema;
exports.frameSchema = frameSchema;
exports.frameVariantSchema = frameVariantSchema;
exports.gossipFrameSchema = gossipFrameSchema;
exports.handleClaimsSchema = handleClaimsSchema;
exports.handleRecordSchema = handleRecordSchema;
exports.handshakeFrameSchema = handshakeFrameSchema;
exports.iceCandidateInitSchema = iceCandidateInitSchema;
exports.identityKeySchema = identityKeySchema;
exports.manageCommandParamsSchema = manageCommandParamsSchema;
exports.manageCommandSchema = manageCommandSchema;
exports.manageErrorSchema = manageErrorSchema;
exports.manageOkSchema = manageOkSchema;
exports.manageRequestFrameSchema = manageRequestFrameSchema;
exports.manageResponseFrameSchema = manageResponseFrameSchema;
exports.namespacedCapabilitySchema = namespacedCapabilitySchema;
exports.namespacedDomainIdSchema = namespacedDomainIdSchema;
exports.observedAddressFrameSchema = observedAddressFrameSchema;
exports.peerAdvertSchema = peerAdvertSchema;
exports.peerIdentitySchema = peerIdentitySchema;
exports.pingFrameSchema = pingFrameSchema;
exports.privateUseCapabilitySchema = privateUseCapabilitySchema;
exports.privateUseDomainIdSchema = privateUseDomainIdSchema;
exports.procKillSchema = procKillSchema;
exports.procSignalSchema = procSignalSchema;
exports.procSpawnSchema = procSpawnSchema;
exports.protocolVersionSchema = protocolVersionSchema;
exports.ptyKillSchema = ptyKillSchema;
exports.ptyResizeSchema = ptyResizeSchema;
exports.ptySpawnSchema = ptySpawnSchema;
exports.ptyWriteSchema = ptyWriteSchema;
exports.relayConnectFrameSchema = relayConnectFrameSchema;
exports.relayDataFrameSchema = relayDataFrameSchema;
exports.relayInboundFrameSchema = relayInboundFrameSchema;
exports.relayOfferFrameSchema = relayOfferFrameSchema;
exports.revocationAnnounceFrameSchema = revocationAnnounceFrameSchema;
exports.revocationClaimsSchema = revocationClaimsSchema;
exports.revocationEntrySchema = revocationEntrySchema;
exports.streamAckFrameSchema = streamAckFrameSchema;
exports.streamDataFrameSchema = streamDataFrameSchema;
exports.streamEndFrameSchema = streamEndFrameSchema;
exports.streamSessionSchema = streamSessionSchema;
exports.syncPunchFrameSchema = syncPunchFrameSchema;
exports.tokenClaimsSchema = tokenClaimsSchema;
exports.webrtcAnswerSchema = webrtcAnswerSchema;
exports.webrtcIceCandidateSchema = webrtcIceCandidateSchema;
exports.webrtcOfferSchema = webrtcOfferSchema;
exports.wireCandidateSchema = wireCandidateSchema;
