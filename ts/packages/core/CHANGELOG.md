## [3.11.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.10.0...wire-mesh-core%403.11.0) (2026-10-02)

### Features

* **core:** carry core/data frames between devices over a relay pairing ([bab75e5](https://github.com/ExaDev/wire-mesh/commit/bab75e5d94b1370205292cc3b36e37a461629e06))

## [3.10.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.9.0...wire-mesh-core%403.10.0) (2026-10-02)

### Features

* **core:** front a relay hub's clients over an uplink ([b4e5d43](https://github.com/ExaDev/wire-mesh/commit/b4e5d433b21bb5da6a893861697644cf5f761d3d))
* **spec:** let a relay connection front several devices ([0962ba8](https://github.com/ExaDev/wire-mesh/commit/0962ba8d66c978c8e9ff4a0391c0b1d129d25b33))

## [3.9.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.8.0...wire-mesh-core%403.9.0) (2026-10-01)

### Features

* **core:** carry a request's refusal code on a typed error ([0df61aa](https://github.com/ExaDev/wire-mesh/commit/0df61aa95cf38136314e9b2c4f6efa1260722033))
* **core:** publish token-scope as a subpath ([531a28b](https://github.com/ExaDev/wire-mesh/commit/531a28b2f4545bc78c19665246ada1a4c1bc8c4e))

## [3.8.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.7.2...wire-mesh-core%403.8.0) (2026-10-01)

### Features

* **core:** gate a capability request on a presented manage:request token ([c87cb09](https://github.com/ExaDev/wire-mesh/commit/c87cb099ed3e262468af3214e3e6ce3954bf1ca1))
* **core:** verify and mint tokens under a grant-capability ([5f57466](https://github.com/ExaDev/wire-mesh/commit/5f57466de2950ea82df606c3e9f4054c6820f5a4))
* **spec:** define the grant permission and subject-mode conditions ([d6ea599](https://github.com/ExaDev/wire-mesh/commit/d6ea5993e2ccdd02ccdf7d2bf3a102a1cf965a3e))
* **spec:** define the request permission as manage:request ([e41b4da](https://github.com/ExaDev/wire-mesh/commit/e41b4da25bacad26912c37722ca92684537c4f1e))

## [3.7.2](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.7.1...wire-mesh-core%403.7.2) (2026-10-01)

### Documentation

* **spec:** record the grant and request permissions as open design again ([46a3955](https://github.com/ExaDev/wire-mesh/commit/46a3955eea070a4d734caa2b709e72563ebccee1))

## [3.7.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.7.0...wire-mesh-core%403.7.1) (2026-10-01)

### Tests

* pin that a delegator may name itself as its delegation's bearer ([02f9684](https://github.com/ExaDev/wire-mesh/commit/02f9684e6a6455cf4beaf5c7410e921203c46dbb))

## [3.7.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.6.1...wire-mesh-core%403.7.0) (2026-10-01)

### Features

* **core:** let a dialled session report the frames it receives ([874dfb6](https://github.com/ExaDev/wire-mesh/commit/874dfb6c41edfd7d5d18765671c8acf49a66cdf8))

### Bug Fixes

* **core:** verify a device's own notices in a DM under the either-participant root policy ([6d2822a](https://github.com/ExaDev/wire-mesh/commit/6d2822a3df374aad3ab26b4453206ff863c4eb5d))

## [3.6.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.6.0...wire-mesh-core%403.6.1) (2026-10-01)

### Bug Fixes

* **core:** reject an unanswered ping with a typed PingTimeoutError ([9e9323b](https://github.com/ExaDev/wire-mesh/commit/9e9323bb136880eaa887fd1a8e54e3fc1e18b544))

### Documentation

* **core:** split the sendPingMeasureRtt contract into paragraphs without dash separators ([c3ae016](https://github.com/ExaDev/wire-mesh/commit/c3ae016a389e8fa16c4a3d7d59275662543b78b3))

## [3.6.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.5.1...wire-mesh-core%403.6.0) (2026-10-01)

### Features

* **core:** let a room key store and the rekey callback be asynchronous ([6136900](https://github.com/ExaDev/wire-mesh/commit/6136900ea9dda357b0cb822f27906ce81d2863b8))

## [3.5.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.5.0...wire-mesh-core%403.5.1) (2026-10-01)

### Bug Fixes

* **core:** report a first connect that fails instead of staying connecting ([3d94922](https://github.com/ExaDev/wire-mesh/commit/3d949225bcbd32e28f96733bd647714e5a30a671))

## [3.5.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.4.0...wire-mesh-core%403.5.0) (2026-09-30)

### Features

* **core:** carry relay offers in peer-advert's extension tail ([2e64322](https://github.com/ExaDev/wire-mesh/commit/2e643223fb0186cabca86ef9fa4c9a7900f8261f)), closes [#292](https://github.com/ExaDev/wire-mesh/issues/292)
* **core:** implement the gossiped coordinator election over coordinator-frame ([efdb099](https://github.com/ExaDev/wire-mesh/commit/efdb0996d880367f32074d839a2bc24a1e6e13d5)), closes [#291](https://github.com/ExaDev/wire-mesh/issues/291)

### Bug Fixes

* **core:** generate the exports map from globbed entries and fail CI on a dirty build ([87ee5fa](https://github.com/ExaDev/wire-mesh/commit/87ee5fabc97c686ec9998af3acb187f4917d434f))
* **core:** narrow the exports map with a type predicate, not an object check ([e07f375](https://github.com/ExaDev/wire-mesh/commit/e07f3751e9024b8a6b7864177aebd85755148094))

### Code Refactoring

* **core:** derive tsdown build entries from the package exports map ([dd0b4e7](https://github.com/ExaDev/wire-mesh/commit/dd0b4e7ad911358f48c652eca437420ce26f8bee))

### Build System

* **core:** build coordinator-election as its own package entry ([ecd2057](https://github.com/ExaDev/wire-mesh/commit/ecd2057b68e98ce88839f0a80f96e2abddb8db4f))
* **core:** build relay-advert as its own package entry ([ac51782](https://github.com/ExaDev/wire-mesh/commit/ac5178252bdede8bdc0eaa8ff2e54e433f5e79da))

## [3.4.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.3.1...wire-mesh-core%403.4.0) (2026-09-30)

### Features

* **core:** encode, decode and merge the certificate hashes a node announces ([20f6f50](https://github.com/ExaDev/wire-mesh/commit/20f6f5097ba6e2fbccb95286eb3715dfa8fb3a4e))
* **core:** let a connection say which address reaches its peer now, and redial with it ([6a7afec](https://github.com/ExaDev/wire-mesh/commit/6a7afecf211cc3c27fbbaabfbef3dea1fb6f6a93))

### Bug Fixes

* **core:** count a session's reconnect attempts afresh once the peer answers ([d4dfc2d](https://github.com/ExaDev/wire-mesh/commit/d4dfc2dd5aed6d7ca3d3563f42173223501794eb))

## [3.3.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.3.0...wire-mesh-core%403.3.1) (2026-09-29)

### Bug Fixes

* **core:** cancel the reader when closing a byte stream whose session has ended ([59e0407](https://github.com/ExaDev/wire-mesh/commit/59e040718277d3cf303764e27bff7dd01a1692eb))
* **core:** forget relay pairings when a session gets a new connection ([dace59d](https://github.com/ExaDev/wire-mesh/commit/dace59d382c10d02e47d66c8557e0dc256eaebfe))

## [3.3.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.2.0...wire-mesh-core%403.3.0) (2026-09-29)

### Features

* **core:** let a pinned address list several certificate hashes ([432b45d](https://github.com/ExaDev/wire-mesh/commit/432b45dcaff5e8f104c702949ed60cb3feeb8ca2))

## [3.2.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.1.0...wire-mesh-core%403.2.0) (2026-09-29)

### Features

* **core:** carry frames over a byte stream and address a node by a pinned certificate hash ([846f8cc](https://github.com/ExaDev/wire-mesh/commit/846f8cc92963d145ed86e1cd59115d22961615a4))
* **core:** let the side that opens a byte stream make it visible to its peer ([4d5d07f](https://github.com/ExaDev/wire-mesh/commit/4d5d07f44787454f1c1a30ff1a9bf6781db1b1e4))

## [3.1.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.0.1...wire-mesh-core%403.1.0) (2026-09-29)

### Features

* **core:** let a relay hub hold other devices' logs while they are offline ([0100500](https://github.com/ExaDev/wire-mesh/commit/01005001f0b0f7adac7acdf27b9d2d10458657c5))

## [3.0.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%403.0.0...wire-mesh-core%403.0.1) (2026-09-29)

### Code Refactoring

* **core:** take only the send half of a session in the capability primitives ([bed7719](https://github.com/ExaDev/wire-mesh/commit/bed7719d45b3a0cd8910f650712d2193ea793972))

## [3.0.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%402.1.0...wire-mesh-core%403.0.0) (2026-09-29)

### ⚠ BREAKING CHANGES

* **core:** manage frames sent through a relay are sealed in the
  secure channel of spec/secure-channel.cddl. A peer on an older core
  cannot exchange them with this one.

### Features

* **core:** carry everything sent through a relay in a secure channel ([e0928e0](https://github.com/ExaDev/wire-mesh/commit/e0928e057aa2b3278b0ecff8e8da27c26f3439dc))
* **core:** the handshake and sealed frames of the secure channel ([e45ac55](https://github.com/ExaDev/wire-mesh/commit/e45ac550ad2c2c40035b1de015b7ccf2b611be48))
* **spec:** define an end-to-end secure channel inside relay-data ([80a993b](https://github.com/ExaDev/wire-mesh/commit/80a993bb4859f092743836b8d71ef7e8e019fbd3))

### Documentation

* point the relay description at the secure channel that defines its ciphertext ([7968b75](https://github.com/ExaDev/wire-mesh/commit/7968b75c08d8cf1fe401188003b2edda88deb4b1))

## [2.1.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%402.0.2...wire-mesh-core%402.1.0) (2026-09-29)

### Features

* **core:** let a relay hub restrict which advert extensions it carries ([0bfe487](https://github.com/ExaDev/wire-mesh/commit/0bfe487996827602709b8f145bc6627a0f2d330a))

## [2.0.2](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%402.0.1...wire-mesh-core%402.0.2) (2026-09-29)

### Bug Fixes

* **core:** do not call unref on a timer handle that has none ([5216d23](https://github.com/ExaDev/wire-mesh/commit/5216d23aafd6a69ede7e38cce7840d58f3246976))

## [2.0.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%402.0.0...wire-mesh-core%402.0.1) (2026-09-20)

### Bug Fixes

* **core:** forget a relay pairing when a request through it times out ([4d6dc9e](https://github.com/ExaDev/wire-mesh/commit/4d6dc9e1305ef2ebe5cd6598ca9221831fd62ffe))

## [2.0.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%401.59.0...wire-mesh-core%402.0.0) (2026-09-20)

### ⚠ BREAKING CHANGES

* **core:** createRelayHub now requires an `identity` option carrying
  verify/deriveDeviceId, and a peer-advert built without `identity-key` and
  `signature` is refused by every receiver.
* **spec:** peer-advert now has two mandatory fields, so an advert built
  without them no longer decodes and every advert must be signed by the device
  it names.
* **rust,conformance:** PeerAdvert has two new mandatory fields in Rust as well, so
  an advert decoded or constructed without them is rejected.

### Features

* **core:** sign every self-advert and verify every gossiped one ([fac52c1](https://github.com/ExaDev/wire-mesh/commit/fac52c18ea37adfa544a1eb130a1de967d72b3c3))
* **rust,conformance:** carry the advert's key and signature through the wire crate ([535ac92](https://github.com/ExaDev/wire-mesh/commit/535ac929cec83980701edfc180b67e149454b132))
* **spec:** require every peer-advert to carry its device's key and signature ([aa278fb](https://github.com/ExaDev/wire-mesh/commit/aa278fbaa9c016dfd24eb88022f950743de5ef8e))

### Documentation

* describe authenticated peer discovery and where an advert is checked ([a57bc06](https://github.com/ExaDev/wire-mesh/commit/a57bc06c7ce48b9bf367f85ee07a9e4897bb23d0))

### Styles

* drop the double-hyphen dash from newly written comments and prose ([f754ff6](https://github.com/ExaDev/wire-mesh/commit/f754ff6abba5aa9e5a72e603fa857a193feb4024))

### Tests

* cover what an advert has to prove, and move every fixture onto real keys ([9304015](https://github.com/ExaDev/wire-mesh/commit/9304015c1b7502e58f539025f9efd47f70a6eed8))

## [1.59.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%401.58.7...wire-mesh-core%401.59.0) (2026-09-20)

### Features

* **core:** export and restore a relay connection's registry and pairing state ([861f7cf](https://github.com/ExaDev/wire-mesh/commit/861f7cf600c69857667bf2077827de2233420d1a))

### Documentation

* point the eviction comments at the issue that reports the dropped response ([37b80ca](https://github.com/ExaDev/wire-mesh/commit/37b80cad261e0a8928417ca31bf86c26127394dc))

## [1.58.7](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%401.58.6...wire-mesh-core%401.58.7) (2026-09-19)

### Bug Fixes

* **core:** match only the wasm-bindgen glue module in tsdown neverBundle ([24cfe8b](https://github.com/ExaDev/wire-mesh/commit/24cfe8bb46356450ea957ce5e4da73e3af1b9faa))

## [1.58.6](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%401.58.5...wire-mesh-core%401.58.6) (2026-09-19)

### Documentation

* state the Rust toolchain prerequisites for working in ts/ ([e705063](https://github.com/ExaDev/wire-mesh/commit/e70506316d9e0eb2a417d94579f0b4101413f07b))

### Build System

* **core:** build wasm-dist through a turbo task its consumers depend on ([1209f6a](https://github.com/ExaDev/wire-mesh/commit/1209f6abf42e5c4a5b6f890077622e9c187bafee))
* **core:** name the exact wasm-bindgen-cli version when it is missing or mismatched ([9b40068](https://github.com/ExaDev/wire-mesh/commit/9b4006869223d9f2754923bf8239f54662b93955))

## [1.58.5](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%401.58.4...wire-mesh-core%401.58.5) (2026-09-19)

### Build System

* **core:** move the tsdown external option to deps.neverBundle ([4273e63](https://github.com/ExaDev/wire-mesh/commit/4273e63e649f629dae85551a2fbd8f559d99ff96))

## [1.58.4](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%401.58.3...wire-mesh-core%401.58.4) (2026-09-19)

### Bug Fixes

* **core:** refuse to pack without the wasm-bindgen output ([554f12c](https://github.com/ExaDev/wire-mesh/commit/554f12cc0709150cf90332f48783edaa040244a1))

## [1.58.3](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-core%401.58.2...wire-mesh-core%401.58.3) (2026-09-19)

### Bug Fixes

* **core:** take trilean 1.6.2, whose published manifest resolves outside its own monorepo ([ed1f21f](https://github.com/ExaDev/wire-mesh/commit/ed1f21ffbd26ddb048af770012105e3808136ab7))

### Build System

* **ts:** release the workspace through @exadev/semantic-release-workspace ([650a0f5](https://github.com/ExaDev/wire-mesh/commit/650a0f560b620f35716548c77120ef970d535dd9))
