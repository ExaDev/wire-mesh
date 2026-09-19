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
