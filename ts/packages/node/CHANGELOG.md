## [3.5.9](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.5.8...wire-mesh%403.5.9) (2026-10-01)


### Dependencies

- Updated wire-mesh-core to 3.7.0
- Updated @exadev/wire-mesh-web-console to 2.14.0

## [3.5.8](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.5.7...wire-mesh%403.5.8) (2026-10-01)


### Dependencies

- Updated wire-mesh-core to 3.6.1
- Updated @exadev/wire-mesh-web-console to 2.13.0

## [3.5.7](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.5.6...wire-mesh%403.5.7) (2026-10-01)


### Dependencies

- Updated wire-mesh-core to 3.6.0
- Updated @exadev/wire-mesh-web-console to 2.12.0

## [3.5.6](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.5.5...wire-mesh%403.5.6) (2026-10-01)


### Dependencies

- Updated wire-mesh-core to 3.5.1
- Updated @exadev/wire-mesh-web-console to 2.11.0

## [3.5.5](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.5.4...wire-mesh%403.5.5) (2026-09-30)

### Documentation

* **node:** record the real-device offline run and what it does not show, and desktop Safari's status ([ac72f80](https://github.com/ExaDev/wire-mesh/commit/ac72f805d81f3915d4eeda782f6b657b7616b654))

## [3.5.4](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.5.3...wire-mesh%403.5.4) (2026-09-30)


### Dependencies

- Updated wire-mesh-core to 3.5.0
- Updated @exadev/wire-mesh-web-console to 2.10.2

## [3.5.3](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.5.2...wire-mesh%403.5.3) (2026-09-30)

### Documentation

* **node:** record that iOS Safari completes the conversation once stream credit is granted ([b56872a](https://github.com/ExaDev/wire-mesh/commit/b56872a8e85230155a22fee6aeadd9d05ebf344e))

## [3.5.2](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.5.1...wire-mesh%403.5.2) (2026-09-30)

### Bug Fixes

* **node:** announce certificates alongside accepting the client's stream, and record the Safari findings ([bba9241](https://github.com/ExaDev/wire-mesh/commit/bba9241e067c20887c3177d5d61f5428baa03138))


### Dependencies

- Updated @exadev/wire-mesh-web-console to 2.10.1

## [3.5.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.5.0...wire-mesh%403.5.1) (2026-09-30)

### Documentation

* **node:** record the browser results so far and the install-script requirement ([c297d67](https://github.com/ExaDev/wire-mesh/commit/c297d67ef7c27846daefeb029a2627bc63a41ccf))

## [3.5.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.4.0...wire-mesh%403.5.0) (2026-09-30)

### Features

* **node:** announce the serving certificates to each session and retry a failed rotation ([4e79250](https://github.com/ExaDev/wire-mesh/commit/4e792505dd86545d2dfc445671d7333292443254))

### Documentation

* specify the WebTransport binding and describe how an address is refreshed ([964dae6](https://github.com/ExaDev/wire-mesh/commit/964dae634f50e8390d0fe073e8911429f68b9561))


### Dependencies

- Updated wire-mesh-core to 3.4.0
- Updated @exadev/wire-mesh-web-console to 2.10.0

## [3.4.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.3.0...wire-mesh%403.4.0) (2026-09-29)

### Features

* **node:** drain the old WebTransport server on rotation and take a certificate lifetime ([2920c3f](https://github.com/ExaDev/wire-mesh/commit/2920c3fc3d14d131fa3adb9305bcd01397957825))

### Documentation

* **node:** record what a certificate rotation does to a conversation ([8564523](https://github.com/ExaDev/wire-mesh/commit/8564523d9508fea8ac33ec7a5096b5e004e6ed76))


### Dependencies

- Updated wire-mesh-core to 3.3.1
- Updated @exadev/wire-mesh-web-console to 2.9.1

## [3.3.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.2.1...wire-mesh%403.3.0) (2026-09-29)

### Features

* **node:** rotate WebTransport certificates on a persisted schedule, listing the next ones in the address ([aa9b77d](https://github.com/ExaDev/wire-mesh/commit/aa9b77d43d34cc6889f562989d652222fa0559ee))

### Documentation

* **node:** describe the certificate renewal schedule and what was checked ([dcf67cb](https://github.com/ExaDev/wire-mesh/commit/dcf67cbc76b3a3f9f0c922881872ecb816415987))


### Dependencies

- Updated wire-mesh-core to 3.3.0
- Updated @exadev/wire-mesh-web-console to 2.9.0

## [3.2.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.2.0...wire-mesh%403.2.1) (2026-09-29)

### Bug Fixes

* **node:** fail --webtransport at startup when the native binary is missing ([bf9dcc2](https://github.com/ExaDev/wire-mesh/commit/bf9dcc2e711ee6429e7aef80bbfaf51c1af4ee66))

## [3.2.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.1.2...wire-mesh%403.2.0) (2026-09-29)

### Features

* **node:** advertise a WebTransport address for each reachable interface and cover the route in the offline scenario ([327c21b](https://github.com/ExaDev/wire-mesh/commit/327c21bd975958c875514c36aed2c0cbf93d5768))
* **node:** serve WebTransport with a self-renewing pinned certificate behind --webtransport ([1440989](https://github.com/ExaDev/wire-mesh/commit/144098983db85bca3484f7de5d360cddf3f6d1da))

### Documentation

* **node:** record the browser and platform coverage of pinned-hash WebTransport ([f0e5a5e](https://github.com/ExaDev/wire-mesh/commit/f0e5a5ec4c656755a9e03e4301677c93d4c14228))

### Tests

* **web-console:** converse through a node over pinned-hash WebTransport in real Chromium ([5258ba4](https://github.com/ExaDev/wire-mesh/commit/5258ba410884cbae6ee8a87e1f76c0b7d8070e70))
* **web-console:** run the WebTransport LAN node on an image with a new enough glibc ([773469b](https://github.com/ExaDev/wire-mesh/commit/773469bbb0f013f5c2986b94da707a9ca6e53978))


### Dependencies

- Updated wire-mesh-core to 3.2.0
- Updated @exadev/wire-mesh-web-console to 2.8.0

## [3.1.2](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.1.1...wire-mesh%403.1.2) (2026-09-29)

### Documentation

* **node:** describe the console dialling a named scheme in the LAN certificate note ([d16df08](https://github.com/ExaDev/wire-mesh/commit/d16df08ec087454969da118029bd79d05dd0dde2))
* **node:** record what a running WebTransport pin check found in each browser and in Node ([cf65437](https://github.com/ExaDev/wire-mesh/commit/cf654370bd63a3349cc2f9f3f2df845ce9b27d94))


### Dependencies

- Updated @exadev/wire-mesh-web-console to 2.7.0

## [3.1.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.1.0...wire-mesh%403.1.1) (2026-09-29)


### Dependencies

- Updated @exadev/wire-mesh-web-console to 2.6.3

## [3.1.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.0.3...wire-mesh%403.1.0) (2026-09-29)

### Features

* **node:** serve the announcer role from a directory with --mailbox-dir ([11fefc6](https://github.com/ExaDev/wire-mesh/commit/11fefc6f29fd51f0600615fda9b4a42f77d2b37e))


### Dependencies

- Updated wire-mesh-core to 3.1.0
- Updated @exadev/wire-mesh-web-console to 2.6.2

## [3.0.3](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.0.2...wire-mesh%403.0.3) (2026-09-29)


### Dependencies

- Updated @exadev/wire-mesh-web-console to 2.6.1

## [3.0.2](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.0.1...wire-mesh%403.0.2) (2026-09-29)


### Dependencies

- Updated wire-mesh-core to 3.0.1
- Updated @exadev/wire-mesh-web-console to 2.6.0

## [3.0.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%403.0.0...wire-mesh%403.0.1) (2026-09-29)


### Dependencies

- Updated @exadev/wire-mesh-web-console to 2.5.2

## [3.0.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%402.0.8...wire-mesh%403.0.0) (2026-09-29)

### ⚠ BREAKING CHANGES

* **core:** manage frames sent through a relay are sealed in the
  secure channel of spec/secure-channel.cddl. A peer on an older core
  cannot exchange them with this one.

### Features

* **core:** carry everything sent through a relay in a secure channel ([e0928e0](https://github.com/ExaDev/wire-mesh/commit/e0928e057aa2b3278b0ecff8e8da27c26f3439dc))


### Dependencies

- Updated wire-mesh-core to 3.0.0
- Updated @exadev/wire-mesh-web-console to 2.5.1

## [2.0.8](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%402.0.7...wire-mesh%402.0.8) (2026-09-29)

### Documentation

* **node:** work through how a LAN node is reached from the HTTPS console ([588b8af](https://github.com/ExaDev/wire-mesh/commit/588b8afc76f84ac1361f61b7c35b9d58431cf8a5))

## [2.0.7](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%402.0.6...wire-mesh%402.0.7) (2026-09-29)


### Dependencies

- Updated @exadev/wire-mesh-web-console to 2.5.0

## [2.0.6](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%402.0.5...wire-mesh%402.0.6) (2026-09-29)


### Dependencies

- Updated wire-mesh-core to 2.1.0
- Updated @exadev/wire-mesh-web-console to 2.4.1

## [2.0.5](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%402.0.4...wire-mesh%402.0.5) (2026-09-29)


### Dependencies

- Updated @exadev/wire-mesh-web-console to 2.4.0

## [2.0.4](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%402.0.3...wire-mesh%402.0.4) (2026-09-29)


### Dependencies

- Updated wire-mesh-core to 2.0.2
- Updated @exadev/wire-mesh-web-console to 2.3.0

## [2.0.3](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%402.0.2...wire-mesh%402.0.3) (2026-09-28)


### Dependencies

- Updated @exadev/wire-mesh-web-console to 2.2.0

## [2.0.2](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%402.0.1...wire-mesh%402.0.2) (2026-09-28)


### Dependencies

- Updated @exadev/wire-mesh-web-console to 2.1.0

## [2.0.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%402.0.0...wire-mesh%402.0.1) (2026-09-20)


### Dependencies

- Updated wire-mesh-core to 2.0.1
- Updated @exadev/wire-mesh-web-console to 2.0.1

## [2.0.0](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%401.0.10...wire-mesh%402.0.0) (2026-09-20)

### ⚠ BREAKING CHANGES

* **core:** createRelayHub now requires an `identity` option carrying
  verify/deriveDeviceId, and a peer-advert built without `identity-key` and
  `signature` is refused by every receiver.

### Features

* **core:** sign every self-advert and verify every gossiped one ([fac52c1](https://github.com/ExaDev/wire-mesh/commit/fac52c18ea37adfa544a1eb130a1de967d72b3c3))

### Tests

* cover what an advert has to prove, and move every fixture onto real keys ([9304015](https://github.com/ExaDev/wire-mesh/commit/9304015c1b7502e58f539025f9efd47f70a6eed8))


### Dependencies

- Updated wire-mesh-core to 2.0.0
- Updated @exadev/wire-mesh-web-console to 2.0.0

## [1.0.10](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%401.0.9...wire-mesh%401.0.10) (2026-09-20)


### Dependencies

- Updated wire-mesh-core to 1.59.0
- Updated @exadev/wire-mesh-web-console to 1.0.5

## [1.0.9](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%401.0.8...wire-mesh%401.0.9) (2026-09-19)


### Dependencies

- Updated wire-mesh-core to 1.58.7
- Updated @exadev/wire-mesh-web-console to 1.0.4

## [1.0.8](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%401.0.7...wire-mesh%401.0.8) (2026-09-19)


### Dependencies

- Updated wire-mesh-core to 1.58.6
- Updated @exadev/wire-mesh-web-console to 1.0.3

## [1.0.7](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%401.0.6...wire-mesh%401.0.7) (2026-09-19)


### Dependencies

- Updated wire-mesh-core to 1.58.5
- Updated @exadev/wire-mesh-web-console to 1.0.2

## [1.0.6](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%401.0.5...wire-mesh%401.0.6) (2026-09-19)

### Documentation

* replace the double hyphen used as a dash in comments ([0bd3b8f](https://github.com/ExaDev/wire-mesh/commit/0bd3b8fd20e46c5be2be653b091419f0cc2fb2aa))

## [1.0.5](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%401.0.4...wire-mesh%401.0.5) (2026-09-19)


### Dependencies

- Updated wire-mesh-core to 1.58.4
- Updated @exadev/wire-mesh-web-console to 1.0.1

## [1.0.4](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%401.0.3...wire-mesh%401.0.4) (2026-09-19)

### Bug Fixes

* **node:** handle --help, --version and invalid flags instead of starting a server ([a668c9f](https://github.com/ExaDev/wire-mesh/commit/a668c9f837ba336f97652a77a05d6b4fd3db1812))

## [1.0.3](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%401.0.2...wire-mesh%401.0.3) (2026-09-19)

### Bug Fixes

* **node:** start the server when the bin is invoked through its install symlink ([5e2a227](https://github.com/ExaDev/wire-mesh/commit/5e2a2272e7d4ba2429a2a0f89a96e1ce0ece50a3))

## [1.0.2](https://github.com/ExaDev/wire-mesh/compare/wire-mesh%401.0.1...wire-mesh%401.0.2) (2026-09-19)

### Build System

* **ts:** release the workspace through @exadev/semantic-release-workspace ([650a0f5](https://github.com/ExaDev/wire-mesh/commit/650a0f560b620f35716548c77120ef970d535dd9))


### Dependencies

- Updated wire-mesh-core to 1.58.3
- Updated @exadev/wire-mesh-web-console to 1.0.0
