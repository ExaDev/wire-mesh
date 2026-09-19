## 1.0.0 (2026-09-19)

### Features

* add ts/packages/cloudflare-hub, a Worker deployment of a hub node ([acd69dc](https://github.com/ExaDev/wire-mesh/commit/acd69dc624770c60a67a8e439e7d1d5730a59d97))
* **cloudflare-hub:** production deployment config + hub-URL live-check argument ([001cb9d](https://github.com/ExaDev/wire-mesh/commit/001cb9d7fdb58c14b637e6b0d0a8a922a61a6951))
* **cloudflare-hub:** serve web-console's built output as static assets ([77554d2](https://github.com/ExaDev/wire-mesh/commit/77554d2992ad46ad90bfcb8629c291961b3d48fb))

### Bug Fixes

* **cloudflare-hub:** rewrite the Durable Object hibernation-native; production relay was silently dead ([ad9e33e](https://github.com/ExaDev/wire-mesh/commit/ad9e33e54ec315617680f371e4635cf10a2464d0)), references [wire-mesh#102](https://github.com/wire-mesh/issues/102)
* **cloudflare-hub:** satisfy the repo's async and readonly-parameter lint rules ([2fd897c](https://github.com/ExaDev/wire-mesh/commit/2fd897cbbe1452d7029e3cf33899895ddec0d862))
* host the hub in a Durable Object -- the plain-Worker entry never relayed a frame ([d8824fd](https://github.com/ExaDev/wire-mesh/commit/d8824fdea1640632dbb3d64f7cce7e398b02c1e9))
* relay-connect teardown is total across pairing roles ([617f778](https://github.com/ExaDev/wire-mesh/commit/617f77864648d41e475628a2f28a3829b2c2c320))
* treat a receive rejection as disconnect, and tear down stale pairings both ways ([b2768be](https://github.com/ExaDev/wire-mesh/commit/b2768be50efc63c42fe2b01e8974e2700179319b))

### Code Refactoring

* **cloudflare-hub:** consume core's shared relay-hub ([f4fddf7](https://github.com/ExaDev/wire-mesh/commit/f4fddf71bde1ddec988f698939d3bbfee39af9fe))
* **test:** declare each test file's kind in its filename ([f42c75a](https://github.com/ExaDev/wire-mesh/commit/f42c75a14c06e3309298b652df461ae55a7ffee3))

### Documentation

* point stale comments at worker.ts; evergreen the README's live-check claim ([2ba33e5](https://github.com/ExaDev/wire-mesh/commit/2ba33e5bf6291ac62c8f0aa9384b551646f2ce6a))

### Tests

* assert relay-data's stamped from-device in the cloudflare-hub and wire-mesh-node suites ([def7833](https://github.com/ExaDev/wire-mesh/commit/def78332516a02e7c088384b767981c974351663))
* **cloudflare-hub:** update relay-hub expectations for gossip forwarding and catch-up ([0b08648](https://github.com/ExaDev/wire-mesh/commit/0b08648e45d5b61bc82232f018cb982f9799d48f))

### Build System

* **deps-dev:** bump wrangler ([ca30ec7](https://github.com/ExaDev/wire-mesh/commit/ca30ec72adc7c14b9cdcae6cba0954c3090a5bbd))
* publish the core package as wire-mesh-core, unscoped ([41845ff](https://github.com/ExaDev/wire-mesh/commit/41845fff2eb45b5f04bd3bec86ce5a143dfec2d4))
* **ts:** release the workspace through @exadev/semantic-release-workspace ([650a0f5](https://github.com/ExaDev/wire-mesh/commit/650a0f560b620f35716548c77120ef970d535dd9))

### Miscellaneous Chores

* **deps:** bump @exadev/eslint-config to 2.12.1 ([a5a0bab](https://github.com/ExaDev/wire-mesh/commit/a5a0baba80b1ff072ccab80f0a8105c3d6bca880))
* **deps:** bump @exadev/eslint-config to 2.18.0 ([6ac41d9](https://github.com/ExaDev/wire-mesh/commit/6ac41d955a27bf7ebccc389ade3ced4b1cdb2c10))
* **deps:** bump the pinned package manager to pnpm 12.4.1 ([1b64bfd](https://github.com/ExaDev/wire-mesh/commit/1b64bfd634f07ac92bc826e499777cf5e050ad86))


### Dependencies

- Updated wire-mesh-core to 1.58.3
