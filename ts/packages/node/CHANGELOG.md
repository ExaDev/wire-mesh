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
