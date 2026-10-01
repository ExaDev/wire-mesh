## [2.14.2](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.14.1...%40exadev%2Fwire-mesh-web-console%402.14.2) (2026-10-01)


### Dependencies

- Updated wire-mesh-core to 3.7.2

## [2.14.1](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.14.0...%40exadev%2Fwire-mesh-web-console%402.14.1) (2026-10-01)


### Dependencies

- Updated wire-mesh-core to 3.7.1

## [2.14.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.13.0...%40exadev%2Fwire-mesh-web-console%402.14.0) (2026-10-01)

### Features

* **web-console:** exchange notice logs with every connected route ([73e5de3](https://github.com/ExaDev/wire-mesh/commit/73e5de35d7e1306f29e2d2b77428a14241397476))
* **web-console:** offer the notice composer over a hub route ([93f3ff5](https://github.com/ExaDev/wire-mesh/commit/93f3ff5ff00257dfe14a414630fe17f490bb50b6))

### Documentation

* **web-console:** describe notice persistence and replication through a hub ([ce6e8f5](https://github.com/ExaDev/wire-mesh/commit/ce6e8f5a0b2af6776677f520c369cdc358a61fb8))

### Tests

* **web-console:** read a notice written while the peer was offline ([dee23f0](https://github.com/ExaDev/wire-mesh/commit/dee23f08846e2b1b8ef3e5f5f4be6d9e374495df))


### Dependencies

- Updated wire-mesh-core to 3.7.0

## [2.13.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.12.0...%40exadev%2Fwire-mesh-web-console%402.13.0) (2026-10-01)

### Features

* **web-console:** back up and restore the device identity key ([c0b1d73](https://github.com/ExaDev/wire-mesh/commit/c0b1d73029a6050f42250beffef2f9acca883983))
* **web-console:** confirm first-use certificates, warn on changes, show peer provenance ([75494db](https://github.com/ExaDev/wire-mesh/commit/75494dbd1f2bb4b171fa581b472f3cfdf9c46915))
* **web-console:** first-run intro, conversation search and phone-width peer tables ([ed6d834](https://github.com/ExaDev/wire-mesh/commit/ed6d8340c36923b879938679be68fdcfb99bf811))
* **web-console:** humanised activity view and connection health ([9812c8b](https://github.com/ExaDev/wire-mesh/commit/9812c8bb842ad0010f4736b1d7e39ead10fe19b0))
* **web-console:** identity and grants panels, with revocations honoured across token checks ([a861428](https://github.com/ExaDev/wire-mesh/commit/a8614283d89b650e3d8574333267ee9f4f1ff00f))
* **web-console:** name peers by petname, self display name or short id ([b979265](https://github.com/ExaDev/wire-mesh/commit/b9792650233acdfc70849d42727f8aa1a9ea97ff))

### Bug Fixes

* **web-console:** apply petname and self-name writes in the order they were made ([aaf1d29](https://github.com/ExaDev/wire-mesh/commit/aaf1d29897b2425d764dae43b6ffd64855816a1e))
* **web-console:** close every open session when the console unmounts ([47ad383](https://github.com/ExaDev/wire-mesh/commit/47ad383ec4369d880d04ec71fcf5fd09562e4791))
* **web-console:** count only unanswered pings as lost, not probes cut short by a dropped connection ([ed7b726](https://github.com/ExaDev/wire-mesh/commit/ed7b7264d1d7d15489d254d984dfb7b0689ccca1))
* **web-console:** dial a known node with only its remembered pins and show gossiped device identity as a claim ([e771b80](https://github.com/ExaDev/wire-mesh/commit/e771b80824b7bb65196b10afecb75a68bbeecbd0))
* **web-console:** draw a dot for every measured round trip so a lone sample shows ([35e1b50](https://github.com/ExaDev/wire-mesh/commit/35e1b50c335cd69a521a291e69eff7e632fa34ed))
* **web-console:** drop a peer's name once it stops advertising one and surface name storage failures ([83ac625](https://github.com/ExaDev/wire-mesh/commit/83ac625a040b774221f3adeb6c15264f65c007b4))
* **web-console:** forget a gossiped candidate's address claims once it connects, and claim no device for a shared address ([22ae5f8](https://github.com/ExaDev/wire-mesh/commit/22ae5f838ffe004be652505b690262a14e92dd9a))
* **web-console:** honour recorded revocations when restoring a persisted room token ([1d6583a](https://github.com/ExaDev/wire-mesh/commit/1d6583af8366908e22c24aa5843de4d2acd5e458))
* **web-console:** keep table roles on the stacked phone layout ([fc9e6d5](https://github.com/ExaDev/wire-mesh/commit/fc9e6d594e52314f73f2886e5dedea3211eee924))
* **web-console:** label the directory time as when the peer advertised itself ([160a072](https://github.com/ExaDev/wire-mesh/commit/160a0726d8c523ecba064aee31cc13a63f3414ef))
* **web-console:** let only the live prompt for a certificate question clear its pending entries ([71d3429](https://github.com/ExaDev/wire-mesh/commit/71d3429115fc7a99a62caf9db47ea4da4af483da))
* **web-console:** mark a self-asserted name as the peer's own claim and trim a name after the length cut ([49dd347](https://github.com/ExaDev/wire-mesh/commit/49dd3473d9b7a72348d9ec37ea7d77d0827a4718))
* **web-console:** mint grants with whole-number expiry and delegation counts and show a failed mint ([9de3a5e](https://github.com/ExaDev/wire-mesh/commit/9de3a5ec964413a7831750060458cf7a9bcd8476))
* **web-console:** name the peer in the conversation header and message request ([c7731cd](https://github.com/ExaDev/wire-mesh/commit/c7731cd3a24c3eb42fab13b0c0e54c71fd57fbc4))
* **web-console:** refuse an identity backup whose private key cannot be loaded as the stored key pair ([728ef2e](https://github.com/ExaDev/wire-mesh/commit/728ef2e72939c4974afdcc38f00e6d067991a135))
* **web-console:** report a first-run intro setting that cannot be read or saved ([6ebc103](https://github.com/ExaDev/wire-mesh/commit/6ebc10347cfb780080de00269b76fe2595eea0ff))
* **web-console:** report each peer as seen once in the activity view ([21644df](https://github.com/ExaDev/wire-mesh/commit/21644df419b1f50c836368ca6c35dd1dd0aa45c3))
* **web-console:** report failed restores, revocations and writes, and render grants through the stacked table ([a47a3ea](https://github.com/ExaDev/wire-mesh/commit/a47a3eabb81f9a3b3182442c23c3a14cf752a0ea))
* **web-console:** retract a published display name when it is cleared and surface publish failures ([595f499](https://github.com/ExaDev/wire-mesh/commit/595f4990baf0330bed9f3447ce4efd8f3573cff3))
* **web-console:** show the first-run intro when its stored answer cannot be read ([830fb5d](https://github.com/ExaDev/wire-mesh/commit/830fb5d6fc086866f7fbb6c13d18532eecb0ecdb))
* **web-console:** show the short id beside a self-asserted name and strip control characters from it ([46cff8a](https://github.com/ExaDev/wire-mesh/commit/46cff8a5ff542e939bb4b30deae382a6e212d71a))
* **web-console:** start with unreadable stored revocations reported and discardable instead of refusing to start ([aa5f28d](https://github.com/ExaDev/wire-mesh/commit/aa5f28d1be31e3d714e660aefe013f0231c37752))
* **web-console:** store only the defining members of a restored identity key ([8a4be73](https://github.com/ExaDev/wire-mesh/commit/8a4be731fe529e94c913a57227de0a1b35790c83))
* **web-console:** write a self-asserted name with its short id in the conversation header and search results ([a052ad0](https://github.com/ExaDev/wire-mesh/commit/a052ad01023ea2f84e9d69d8ef53c9c97a42ed59))

### Documentation

* **web-console:** describe all three jsdom stubs in the Mantine polyfills header ([292f534](https://github.com/ExaDev/wire-mesh/commit/292f5346123e089a1b6a90ade3e35c15d61c5fc2))
* **web-console:** describe certificate pinning and naming as they behave, without dash separators ([2300dfd](https://github.com/ExaDev/wire-mesh/commit/2300dfdd58e782429489640a39bbed0c5c1cf542))
* **web-console:** describe identity backup, grants and revocation relaying ([97ca77d](https://github.com/ExaDev/wire-mesh/commit/97ca77dbf52d11291a75ef90d6a14b626c296454))
* **web-console:** describe naming, trust, activity, first run and search ([826e065](https://github.com/ExaDev/wire-mesh/commit/826e065b2a65ab8ab4a97d7fc2034ae8272636f5))
* **web-console:** reword the session events hook header without a spaced double hyphen ([438ea70](https://github.com/ExaDev/wire-mesh/commit/438ea70bcb621a311a827dab0ad15bc93a9c2746))

### Tests

* **web-console:** accept the first-use certificate prompt in the pinned-address end-to-end specs ([359bfbd](https://github.com/ExaDev/wire-mesh/commit/359bfbda9347b38a1674d1d93f7f9200122de31b))
* **web-console:** assert the message request names the requester with its short id ([f8b74b0](https://github.com/ExaDev/wire-mesh/commit/f8b74b08f52ff0771328bb9e5b3a47cab095aa32))
* **web-console:** cover revocation wiring in App and share the App test harness ([06c13ce](https://github.com/ExaDev/wire-mesh/commit/06c13ce9ea300e5f2c3307f0fb1b78554937b1f4))
* **web-console:** give the shared harness and call sites the props the hooks now take ([bcce54f](https://github.com/ExaDev/wire-mesh/commit/bcce54f4265f2a86978196b38854aef0cd37b45a))
* **web-console:** list every gossiped candidate before dialling one in the claim tests ([20daac7](https://github.com/ExaDev/wire-mesh/commit/20daac73456504527e6333aa45ea1600fc02e320))
* **web-console:** make the unresponsive-node probe test independent of interval timing ([2bcdfdd](https://github.com/ExaDev/wire-mesh/commit/2bcdfdd37833a0dc2db7f9edd0f005b7317e8bc1))
* **web-console:** open the raw frame log before counting handshakes in the reconnect specs ([0b08de6](https://github.com/ExaDev/wire-mesh/commit/0b08de62376d4e6328e253594559b6650747db37))
* **web-console:** pass the clock to the certificate trust hook in the stale-prompt test ([80687ab](https://github.com/ExaDev/wire-mesh/commit/80687ab43ea663c3ba5214b6a4b1c9cc1a27a5b3))
* **web-console:** pin the reconnect countdown to the attempt's own backoff delay ([f49808d](https://github.com/ExaDev/wire-mesh/commit/f49808d31499d9392555d856474806268ddfeccb))
* **web-console:** render the local-network panel test inside the names context ([8017abb](https://github.com/ExaDev/wire-mesh/commit/8017abb49436651c6ee3f2b0f1a94ed13f8939a4))


### Dependencies

- Updated wire-mesh-core to 3.6.1

## [2.12.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.11.0...%40exadev%2Fwire-mesh-web-console%402.12.0) (2026-10-01)

### Features

* **web-console:** keep notice logs, room keys and room tokens across reloads ([31d0633](https://github.com/ExaDev/wire-mesh/commit/31d0633e89013ec35e2d88239f73775b1a3e0082))

### Tests

* **web-console:** await asynchronous room key writes in notice tests ([60db23e](https://github.com/ExaDev/wire-mesh/commit/60db23eaf3cce8400aa244d106db68da7387cb7f))


### Dependencies

- Updated wire-mesh-core to 3.6.0

## [2.11.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.10.2...%40exadev%2Fwire-mesh-web-console%402.11.0) (2026-10-01)

### Features

* **web-console:** recognise a local address and read the browser's local network permission ([58c6db7](https://github.com/ExaDev/wire-mesh/commit/58c6db72e95a079d4abd0b4f192ceef71d334cef))
* **web-console:** say why a connection to a local address failed when the browser denied local network access ([9bb2a06](https://github.com/ExaDev/wire-mesh/commit/9bb2a06362d311c2fac41c05d15d6cf061edbe0d))


### Dependencies

- Updated wire-mesh-core to 3.5.1

## [2.10.2](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.10.1...%40exadev%2Fwire-mesh-web-console%402.10.2) (2026-09-30)

### Tests

* **web-console:** implement the coordinator members on the notices session double ([1a6637d](https://github.com/ExaDev/wire-mesh/commit/1a6637d47e0925a811a3465bca31fbc2ad4fe401))


### Dependencies

- Updated wire-mesh-core to 3.5.0

## [2.10.1](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.10.0...%40exadev%2Fwire-mesh-web-console%402.10.1) (2026-09-30)

### Bug Fixes

* **web-console:** say why a browser that cannot open a WebTransport stream fails to connect ([20c6fcd](https://github.com/ExaDev/wire-mesh/commit/20c6fcd0058c6e551b50d6746b99e8c1bf1083de))

## [2.10.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.9.1...%40exadev%2Fwire-mesh-web-console%402.10.0) (2026-09-30)

### Features

* **web-console:** pin what a node announced, remember it, and redial with it ([142eeba](https://github.com/ExaDev/wire-mesh/commit/142eebae5991140cd10e058151a1039b07563079))


### Dependencies

- Updated wire-mesh-core to 3.4.0

## [2.9.1](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.9.0...%40exadev%2Fwire-mesh-web-console%402.9.1) (2026-09-29)

### Bug Fixes

* **web-console:** end a WebTransport connection when its session closes ([9073003](https://github.com/ExaDev/wire-mesh/commit/907300357bb241b70822264e9df2b81669ff6ec1))


### Dependencies

- Updated wire-mesh-core to 3.3.1

## [2.9.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.8.0...%40exadev%2Fwire-mesh-web-console%402.9.0) (2026-09-29)

### Features

* **web-console:** pin every hash an address lists ([24ec973](https://github.com/ExaDev/wire-mesh/commit/24ec9735357a46bc8bf14dacae0449715c3401d1))


### Dependencies

- Updated wire-mesh-core to 3.3.0

## [2.8.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.7.0...%40exadev%2Fwire-mesh-web-console%402.8.0) (2026-09-29)

### Features

* **node:** advertise a WebTransport address for each reachable interface and cover the route in the offline scenario ([327c21b](https://github.com/ExaDev/wire-mesh/commit/327c21bd975958c875514c36aed2c0cbf93d5768))
* **web-console:** dial a pinned-hash address over WebTransport ([d6f2d2b](https://github.com/ExaDev/wire-mesh/commit/d6f2d2b408c163dc1adeaf57619d36802dbb8087))

### Tests

* **web-console:** converse through a node over pinned-hash WebTransport in real Chromium ([5258ba4](https://github.com/ExaDev/wire-mesh/commit/5258ba410884cbae6ee8a87e1f76c0b7d8070e70))
* **web-console:** print each side's page when the offline exchange fails ([9ec9595](https://github.com/ExaDev/wire-mesh/commit/9ec95950f2b9243075baffa81050800e13fac63e))
* **web-console:** run the WebTransport LAN node on an image with a new enough glibc ([773469b](https://github.com/ExaDev/wire-mesh/commit/773469bbb0f013f5c2986b94da707a9ca6e53978))
* **web-console:** show the LAN node's output when it prints no WebTransport address ([75dd094](https://github.com/ExaDev/wire-mesh/commit/75dd094c2be4683c6372331ee247286291745ed1))
* **web-console:** start each offline route from a copy of the warmed profile ([94b2907](https://github.com/ExaDev/wire-mesh/commit/94b2907d2f74522303a2befc6432f9a96914f868))


### Dependencies

- Updated wire-mesh-core to 3.2.0

## [2.7.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.6.3...%40exadev%2Fwire-mesh-web-console%402.7.0) (2026-09-29)

### Features

* **web-console:** dial an address with the scheme it names ([12a7130](https://github.com/ExaDev/wire-mesh/commit/12a7130677ec555ba3a1494bbe0ac0f6cf8788dd))

## [2.6.3](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.6.2...%40exadev%2Fwire-mesh-web-console%402.6.3) (2026-09-29)

### Tests

* **web-console:** fail the offline scenario when a route's outcome differs from what is expected ([9d2f2a8](https://github.com/ExaDev/wire-mesh/commit/9d2f2a87f73f196c997b18aa422800d6beeb06f6))
* **web-console:** include the offline Playwright config in the node tsconfig ([a09772d](https://github.com/ExaDev/wire-mesh/commit/a09772dbd74d4d9afe548c45adf09facf9fa2152))
* **web-console:** keep vitest out of the offline container spec ([1976fe1](https://github.com/ExaDev/wire-mesh/commit/1976fe1768e306daaff9246c46e0f779612fd746))
* **web-console:** run two consoles offline against a LAN node from a cached console ([2a72205](https://github.com/ExaDev/wire-mesh/commit/2a7220553db200ebf728ce98d180e927622ec127))

## [2.6.2](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.6.1...%40exadev%2Fwire-mesh-web-console%402.6.2) (2026-09-29)


### Dependencies

- Updated wire-mesh-core to 3.1.0

## [2.6.1](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.6.0...%40exadev%2Fwire-mesh-web-console%402.6.1) (2026-09-29)

### Tests

* **web-console:** run the two consoles on networks with only the hub in common ([7f4e042](https://github.com/ExaDev/wire-mesh/commit/7f4e04274eac82e7340886507ceac55de8081498))

## [2.6.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.5.2...%40exadev%2Fwire-mesh-web-console%402.6.0) (2026-09-29)

### Features

* **web-console:** carry a conversation through the hub when no direct connection opens ([7c6095e](https://github.com/ExaDev/wire-mesh/commit/7c6095e810043b57cc1e743d779c0a36ef86623d))

### Tests

* **web-console:** match the container spec's messages exactly ([be060eb](https://github.com/ExaDev/wire-mesh/commit/be060eb65c3f42567a3b5af0baa4ab4831e5817d))


### Dependencies

- Updated wire-mesh-core to 3.0.1

## [2.5.2](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.5.1...%40exadev%2Fwire-mesh-web-console%402.5.2) (2026-09-29)

### Tests

* **web-console:** keep the certificate service running and bound the job ([d8c5014](https://github.com/ExaDev/wire-mesh/commit/d8c501407b8fa4b5527c59a8bf39aab2871593a8))
* **web-console:** run the two consoles in separate containers ([e495287](https://github.com/ExaDev/wire-mesh/commit/e495287e4e7c08f2d0d689528302fd335057bb9e))
* **web-console:** serve the container hub over TLS ([efaac12](https://github.com/ExaDev/wire-mesh/commit/efaac122b7dc8f6d41482608f537449dce044948))

## [2.5.1](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.5.0...%40exadev%2Fwire-mesh-web-console%402.5.1) (2026-09-29)


### Dependencies

- Updated wire-mesh-core to 3.0.0

## [2.5.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.4.1...%40exadev%2Fwire-mesh-web-console%402.5.0) (2026-09-29)

### Features

* **web-console:** say a message is waiting for the other side's consent ([548c117](https://github.com/ExaDev/wire-mesh/commit/548c11705ffbe71fb038b30e141fd2089e7885ad))

## [2.4.1](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.4.0...%40exadev%2Fwire-mesh-web-console%402.4.1) (2026-09-29)


### Dependencies

- Updated wire-mesh-core to 2.1.0

## [2.4.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.3.0...%40exadev%2Fwire-mesh-web-console%402.4.0) (2026-09-29)

### Features

* **web-console:** configure STUN so a direct connection can form across NATs ([3eb7dd3](https://github.com/ExaDev/wire-mesh/commit/3eb7dd325f550f9c459ec4f0b734212b3bb8cfa7))

## [2.3.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.2.0...%40exadev%2Fwire-mesh-web-console%402.3.0) (2026-09-29)

### Features

* **web-console:** show why a message attempt failed ([cb0c325](https://github.com/ExaDev/wire-mesh/commit/cb0c325a5e069740d4ba88683965a5e3ffd791e5))

### Bug Fixes

* **web-console:** send the webrtc:signal token with every offer ([2b83cbb](https://github.com/ExaDev/wire-mesh/commit/2b83cbb152d1123106445ea05fc38307e528aaa7))

### Tests

* **web-console:** fail the e2e specs when the data channel does not open ([a49cf00](https://github.com/ExaDev/wire-mesh/commit/a49cf00afd39f0137784f12a6655255b5717c6d2))
* **web-console:** send before approving in the room-messaging e2e ([04cec8e](https://github.com/ExaDev/wire-mesh/commit/04cec8e731a376767b902633ae0f28775bd9e32a))


### Dependencies

- Updated wire-mesh-core to 2.0.2

## [2.2.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.1.0...%40exadev%2Fwire-mesh-web-console%402.2.0) (2026-09-28)

### Features

* **web-console:** show sender, time and delivery state in the message list ([4ad670f](https://github.com/ExaDev/wire-mesh/commit/4ad670fa24dc4065080bb87ecf4c3ac56ebb41bc))

### Documentation

* **web-console:** describe sending and failed-send state in the messaging section ([5bdfbba](https://github.com/ExaDev/wire-mesh/commit/5bdfbbab9a125cc380133b41c5ff7eebc97e6f97))

## [2.1.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.0.1...%40exadev%2Fwire-mesh-web-console%402.1.0) (2026-09-28)

### Features

* **web-console:** key conversations by room path and add a conversation list ([7bf1511](https://github.com/ExaDev/wire-mesh/commit/7bf15116ccd76b40f9e2f5e12780bac5a8171686))
* **web-console:** list the room paths that have stored messages ([c2ffb06](https://github.com/ExaDev/wire-mesh/commit/c2ffb060f761ed4d9c18199384b7d2a728fdb0c3))

### Documentation

* **web-console:** describe the conversation model and correct the deferred list ([4deaa81](https://github.com/ExaDev/wire-mesh/commit/4deaa8150a0a5eb811d4728aa16ee851c4495888))

## [2.0.1](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%402.0.0...%40exadev%2Fwire-mesh-web-console%402.0.1) (2026-09-20)


### Dependencies

- Updated wire-mesh-core to 2.0.1

## [2.0.0](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%401.0.5...%40exadev%2Fwire-mesh-web-console%402.0.0) (2026-09-20)

### ⚠ BREAKING CHANGES

* **rust,conformance:** PeerAdvert has two new mandatory fields in Rust as well, so
  an advert decoded or constructed without them is rejected.

### Features

* **rust,conformance:** carry the advert's key and signature through the wire crate ([535ac92](https://github.com/ExaDev/wire-mesh/commit/535ac929cec83980701edfc180b67e149454b132))

### Bug Fixes

* **web-console:** give the live-check gossip shape one definition ([0cca623](https://github.com/ExaDev/wire-mesh/commit/0cca6238becef6a8a18a5f656cfefd582d02a6d1))

### Styles

* drop the double-hyphen dash from newly written comments and prose ([f754ff6](https://github.com/ExaDev/wire-mesh/commit/f754ff6abba5aa9e5a72e603fa857a193feb4024))

### Tests

* cover what an advert has to prove, and move every fixture onto real keys ([9304015](https://github.com/ExaDev/wire-mesh/commit/9304015c1b7502e58f539025f9efd47f70a6eed8))


### Dependencies

- Updated wire-mesh-core to 2.0.0

## [1.0.5](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%401.0.4...%40exadev%2Fwire-mesh-web-console%401.0.5) (2026-09-20)


### Dependencies

- Updated wire-mesh-core to 1.59.0

## [1.0.4](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%401.0.3...%40exadev%2Fwire-mesh-web-console%401.0.4) (2026-09-19)


### Dependencies

- Updated wire-mesh-core to 1.58.7

## [1.0.3](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%401.0.2...%40exadev%2Fwire-mesh-web-console%401.0.3) (2026-09-19)


### Dependencies

- Updated wire-mesh-core to 1.58.6

## [1.0.2](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%401.0.1...%40exadev%2Fwire-mesh-web-console%401.0.2) (2026-09-19)


### Dependencies

- Updated wire-mesh-core to 1.58.5

## [1.0.1](https://github.com/ExaDev/wire-mesh/compare/%40exadev%2Fwire-mesh-web-console%401.0.0...%40exadev%2Fwire-mesh-web-console%401.0.1) (2026-09-19)


### Dependencies

- Updated wire-mesh-core to 1.58.4

## 1.0.0 (2026-09-19)

### Features

* add ts/packages/web-console, the browser client ([6bae4ab](https://github.com/ExaDev/wire-mesh/commit/6bae4ab288d278b7eb61418fabff949f86f96554))
* **core:** catch up a gossiping relay-hub connection with every other already-known device ([e2e500d](https://github.com/ExaDev/wire-mesh/commit/e2e500dc05e7031e2a7e867b0ac6b4460545e992)), references [101/#110](https://github.com/ExaDev/wire-mesh/issues/110)
* **core:** measure real ping/pong RTT, and reply to ping with pong on relay-hub ([9784a9e](https://github.com/ExaDev/wire-mesh/commit/9784a9ee81ec280b49d8538102d1e9da6ca64eb8))
* **core:** promote MeshSession into core, add acceptMeshSession ([bf795ae](https://github.com/ExaDev/wire-mesh/commit/bf795ae2760400d393178a602a52a6fd727b909b)), references [wire-mesh#45](https://github.com/wire-mesh/issues/45)
* **web-console:** add a WebRTC DataChannel transport adapter ([044439c](https://github.com/ExaDev/wire-mesh/commit/044439cc0117405ba99f1a359cbd117fcd35f04a))
* **web-console:** add IndexedDB storage adapter ([667f546](https://github.com/ExaDev/wire-mesh/commit/667f54630eedd810c72787498c82e6795b3609d0))
* **web-console:** add persisted Web Crypto identity backed by IndexedDB storage ([8dded07](https://github.com/ExaDev/wire-mesh/commit/8dded07199ec1cc8aeb6a67079c5bd1ac7e81406))
* **web-console:** add same-device wire-mesh-node discovery ([8584360](https://github.com/ExaDev/wire-mesh/commit/858436092789e2dedc8004a512a39fa2a51b222b))
* **web-console:** add the web app manifest and its icons ([1a5f0d5](https://github.com/ExaDev/wire-mesh/commit/1a5f0d52999f47dcc7ae89126bfe256b5528a6d4))
* **web-console:** add Web Crypto identity adapter ([df0c693](https://github.com/ExaDev/wire-mesh/commit/df0c6932fc082ac556011542abf7569ac1ff7bf3))
* **web-console:** add WebRTC signaling orchestration ([b5fe46c](https://github.com/ExaDev/wire-mesh/commit/b5fe46cf337997dfc712b1a2e32560945b13e01a))
* **web-console:** auto-connect to a discovered same-device node on mount ([1346d80](https://github.com/ExaDev/wire-mesh/commit/1346d80ab03baf933ccc94f423924cbe10e5c918))
* **web-console:** capability-token handling and generic manage-request plumbing ([032161d](https://github.com/ExaDev/wire-mesh/commit/032161d4719a8fc255724e17503d89a83620bc82))
* **web-console:** carry audio/video tracks over core/webrtc's existing offer/answer exchange ([e5a3350](https://github.com/ExaDev/wire-mesh/commit/e5a3350212e6b395ae5d574d9087e1499a24d817))
* **web-console:** default the Node field to the page's own origin ([0d7280c](https://github.com/ExaDev/wire-mesh/commit/0d7280cf5202f0794d4606c1502ab7df4b450eb6))
* **web-console:** dial gossiped peer addresses once the user approves ([88434d7](https://github.com/ExaDev/wire-mesh/commit/88434d73e31583422cdf22dec7e95abbe2716736))
* **web-console:** drive core/room messaging over per-peer WebRTC connections ([59c20e4](https://github.com/ExaDev/wire-mesh/commit/59c20e481055197f3e8ee5a1367f128bb80e95f4))
* **web-console:** drive core/room over a MeshSession with a unified request router ([263f0d5](https://github.com/ExaDev/wire-mesh/commit/263f0d584c94d5d09a413c22c952cb9619692644))
* **web-console:** generate an offline-capable service worker ([511a85e](https://github.com/ExaDev/wire-mesh/commit/511a85e342b6a92cb7fc690a12e2895bbd009adb))
* **web-console:** give persisted web identities ECDH capability ([b016476](https://github.com/ExaDev/wire-mesh/commit/b0164765906ae4dbd36c71faf7f31203d45a9b61))
* **web-console:** notices view + the room router's room.rekey dispatch slot ([e68b98e](https://github.com/ExaDev/wire-mesh/commit/e68b98e53051c3d6446d90c0b2d9f40b4491ea1b)), references [wire-mesh#36](https://github.com/wire-mesh/issues/36)
* **web-console:** persist per-room message history over KeyValueStorage ([a3be6b1](https://github.com/ExaDev/wire-mesh/commit/a3be6b10e76a93c90506ab2f5ca32df79c11708e))
* **web-console:** post durable encrypted notices from the room UI ([1c5b154](https://github.com/ExaDev/wire-mesh/commit/1c5b154484ad29cfbee41f2640ebf2a90b4e147f))
* **web-console:** prompt for reload when a new build is ready ([c8590e8](https://github.com/ExaDev/wire-mesh/commit/c8590e8c877af333340c47cd1d94013e6cf50179))
* **web-console:** reconnect with backoff ([2c3090d](https://github.com/ExaDev/wire-mesh/commit/2c3090da74c023fa615283a57973f0269edfd97b))
* **web-console:** rewrite the connection console as React + Mantine components ([a3f4268](https://github.com/ExaDev/wire-mesh/commit/a3f426871aef843d738e7731542f28c5392cfdb9))
* **web-console:** route manage-request/response through an established relay pairing ([45847f1](https://github.com/ExaDev/wire-mesh/commit/45847f10e28633aea658e8ef4d23d3985a67b34d))
* **web-console:** send a self-advertisement gossip frame after handshake ([2b790e7](https://github.com/ExaDev/wire-mesh/commit/2b790e77a83f19b97b465416e46285a9e5467e23))
* **web-console:** support multiple concurrent connections ([a612847](https://github.com/ExaDev/wire-mesh/commit/a612847448a2e23d1f4f388d9773bb5edf0527db))
* **web-console:** target WebRTC signaling at a specific peer via relay ([0b3983f](https://github.com/ExaDev/wire-mesh/commit/0b3983fc6688987506f1f76008124b0d5cfffd96))
* **web-console:** wire room.invite onto capability-grant ([835d2f3](https://github.com/ExaDev/wire-mesh/commit/835d2f39acfa49d92386fac10d9a1161fb04d3db))
* **web-console:** wire the noticeboard onto a session's frame flow ([b17f274](https://github.com/ExaDev/wire-mesh/commit/b17f274a035886f2bf706fb4695bede77b172932))

### Bug Fixes

* **core:** pin KeyValueStorage's byte values to Uint8Array<ArrayBuffer> ([da3c4d8](https://github.com/ExaDev/wire-mesh/commit/da3c4d8e310244fcd3932d132a429c8991ac5402))
* **web-console,wire-mesh-sfu:** add getTopologyPeers to structurally-typed MeshSession test doubles ([69cb766](https://github.com/ExaDev/wire-mesh/commit/69cb76666eca07d307e05eb4721f8001f221d278))
* **web-console:** clear the handshake timeout on reconnect ([fdbb498](https://github.com/ExaDev/wire-mesh/commit/fdbb498be6a2fb34f4c8521f40cfb8f2a141d695))
* **web-console:** parse the room.join success response with its own schema in tests ([bbd86ab](https://github.com/ExaDev/wire-mesh/commit/bbd86abf6b5133d07dcd250c98969ca81a474d81))
* **web-console:** register the e2e turbo task so pnpm test:e2e actually runs it ([583d04a](https://github.com/ExaDev/wire-mesh/commit/583d04ada1c43aef104d4ca5e336bb2a5c57e3ca))
* **web-console:** reject pending manage-requests on close and disconnect ([dbfd3fa](https://github.com/ExaDev/wire-mesh/commit/dbfd3fab725c875f28b0777fd957694a216598a2))
* **web-console:** use a single-code-unit prefix upper bound for IndexedDB range scans ([b268aff](https://github.com/ExaDev/wire-mesh/commit/b268affb699755ff5778b357f41ee711e4dff715))
* **web-console:** wire a default reconnect policy into every session ([aae38fa](https://github.com/ExaDev/wire-mesh/commit/aae38fac7f6b64cba70d4a7ed71634b2e4ff8644))

### Code Refactoring

* **core:** change RevocationCheck from isRevoked to entriesFor ([11ae816](https://github.com/ExaDev/wire-mesh/commit/11ae8165d7d575876c98cf19d553424bd8260534))
* **test:** declare each test file's kind in its filename ([f42c75a](https://github.com/ExaDev/wire-mesh/commit/f42c75a14c06e3309298b652df461ae55a7ffee3))
* **web-console:** consume webrtc signaling from wire-mesh-core ([387d1f6](https://github.com/ExaDev/wire-mesh/commit/387d1f608382c0087d4bf8acc435f694732c64a0))
* **web-console:** extract shared frame codec from the websocket adapter ([08120e9](https://github.com/ExaDev/wire-mesh/commit/08120e92a25289f52577ef004fbadd0cdd3249e9))
* **web-console:** replace RoomPanel's duplicated compose rows with web-ui-primitives SubmitRow ([e32375d](https://github.com/ExaDev/wire-mesh/commit/e32375d6dcc3a109baeed0b1cc32b69a087f4ca3))
* **web-console:** rewire room.join onto generic capability-request ([e6e79f8](https://github.com/ExaDev/wire-mesh/commit/e6e79f8dbf306ae912a4f8c3e32eb6c017288417))

### Documentation

* **web-console:** describe identity, tokens, reconnect, multi-connection, and relayed signaling ([0491541](https://github.com/ExaDev/wire-mesh/commit/0491541c181821125b84b2291ca1011c04b73507))
* **web-console:** describe room.invite in createRoomRouter's own comment ([a69afab](https://github.com/ExaDev/wire-mesh/commit/a69afabf7e9922a6dcecc0b9ef780ac4e09df2cb))
* **web-console:** document PWA offline scope and icon limitation ([bc32fbf](https://github.com/ExaDev/wire-mesh/commit/bc32fbf2fdfdcea94470525746af69143d473407))

### Styles

* **web-console:** apply prettier formatting to describeFrame's ternary ([791eb11](https://github.com/ExaDev/wire-mesh/commit/791eb112127e4438b0651469bdda13d96d3b3496))
* **web-console:** cap and centre the console's content width via vanilla-extract ([5083319](https://github.com/ExaDev/wire-mesh/commit/50833194bbb57220d40660d7e234808572d6edc2))

### Tests

* **web-console:** add a Playwright live-check for the WebRTC data path ([b344e57](https://github.com/ExaDev/wire-mesh/commit/b344e57c1355b41bf28f1df0cecafd33a5264405))
* **web-console:** add a real UI-level room-messaging e2e test, skipped ([18cbc48](https://github.com/ExaDev/wire-mesh/commit/18cbc48016fe3757e27af329fbaebe3444b21bac)), references [wire-mesh#110](https://github.com/wire-mesh/issues/110) [#110](https://github.com/ExaDev/wire-mesh/issues/110)
* **web-console:** assert the web app manifest's installable shape ([8e0b14c](https://github.com/ExaDev/wire-mesh/commit/8e0b14c8a0936a7641be7bbc02e51b5d1bf0539b))
* **web-console:** close main.ts's zero test-coverage gap ([ee7b109](https://github.com/ExaDev/wire-mesh/commit/ee7b109be68ecab1b37a3cb2717b7199d98fbceb))
* **web-console:** cover the React App with the same scenarios main.test.ts had ([42c2204](https://github.com/ExaDev/wire-mesh/commit/42c22049a55cc4b5c7b90494584f401b142428d2))
* **web-console:** launch two separate Chromium browser instances for the WebRTC e2e test ([030d95f](https://github.com/ExaDev/wire-mesh/commit/030d95f42939264edbff1b8d2894ecd6f1a45250))
* **web-console:** replace the manual WebRTC live-check with a real, CI-run Playwright test ([53b099b](https://github.com/ExaDev/wire-mesh/commit/53b099b55ea689e43a66701c068701b5f67025e1))
* **web-console:** serialise e2e workers so spec files never share the live relay hub concurrently ([090fbbb](https://github.com/ExaDev/wire-mesh/commit/090fbbb6b3087bc824b73c878c1a14813164b229))
* **web-console:** verify WebRTC signaling over a real wire-mesh-node relay ([94b20bc](https://github.com/ExaDev/wire-mesh/commit/94b20bc8532963c264e2811fe4c679d5c03005ae))

### Build System

* publish the core package as wire-mesh-core, unscoped ([41845ff](https://github.com/ExaDev/wire-mesh/commit/41845fff2eb45b5f04bd3bec86ce5a143dfec2d4))
* **ts:** release the workspace through @exadev/semantic-release-workspace ([650a0f5](https://github.com/ExaDev/wire-mesh/commit/650a0f560b620f35716548c77120ef970d535dd9))

### Miscellaneous Chores

* **deps:** bump @exadev/eslint-config to 2.12.1 ([a5a0bab](https://github.com/ExaDev/wire-mesh/commit/a5a0baba80b1ff072ccab80f0a8105c3d6bca880))
* **deps:** bump @exadev/eslint-config to 2.18.0 ([6ac41d9](https://github.com/ExaDev/wire-mesh/commit/6ac41d955a27bf7ebccc389ade3ced4b1cdb2c10))
* **deps:** bump the pinned package manager to pnpm 12.4.1 ([1b64bfd](https://github.com/ExaDev/wire-mesh/commit/1b64bfd634f07ac92bc826e499777cf5e050ad86))
* **web-console:** add react, react-dom, mantine, and tslib ([ad0234c](https://github.com/ExaDev/wire-mesh/commit/ad0234cef80073747695b52f09bdb76ccd5db633))
* **web-console:** add vanilla-extract, react vite plugin, and testing/postcss deps ([058e281](https://github.com/ExaDev/wire-mesh/commit/058e28127ef90bcf5b9739a34e30239826ad3ec9))
* **web-console:** add vite-plugin-pwa and workbox-window ([732f500](https://github.com/ExaDev/wire-mesh/commit/732f500005be97961076139b526256e7fa2be610))


### Dependencies

- Updated wire-mesh-core to 1.58.3
