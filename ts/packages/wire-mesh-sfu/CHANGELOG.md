## [1.0.3](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-sfu%401.0.2...wire-mesh-sfu%401.0.3) (2026-09-19)


### Dependencies

- Updated wire-mesh-core to 1.58.4
- Updated wire-mesh to 1.0.5

## [1.0.2](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-sfu%401.0.1...wire-mesh-sfu%401.0.2) (2026-09-19)


### Dependencies

- Updated wire-mesh to 1.0.4

## [1.0.1](https://github.com/ExaDev/wire-mesh/compare/wire-mesh-sfu%401.0.0...wire-mesh-sfu%401.0.1) (2026-09-19)


### Dependencies

- Updated wire-mesh to 1.0.3

## 1.0.0 (2026-09-19)

### Features

* **core:** measure real ping/pong RTT, and reply to ping with pong on relay-hub ([9784a9e](https://github.com/ExaDev/wire-mesh/commit/9784a9ee81ec280b49d8538102d1e9da6ca64eb8))
* **sfu:** add SDP<->mediasoup bridge and per-call session orchestration ([9ff074f](https://github.com/ExaDev/wire-mesh/commit/9ff074fd9b416d37255630b80766431328fdff86))
* **sfu:** implement the mediasoup media backend and CLI service ([0598472](https://github.com/ExaDev/wire-mesh/commit/059847202eb7d7a63f80b26cf20c1033f34bf2cc))
* **sfu:** scaffold wire-mesh-sfu package with mediasoup and its media-backend port ([35d377e](https://github.com/ExaDev/wire-mesh/commit/35d377ead9585b5195d4dee67be3bfdc290aefde))

### Bug Fixes

* **web-console,wire-mesh-sfu:** add getTopologyPeers to structurally-typed MeshSession test doubles ([69cb766](https://github.com/ExaDev/wire-mesh/commit/69cb76666eca07d307e05eb4721f8001f221d278))

### Documentation

* **sfu:** document the wire-mesh-sfu package ([8e80f92](https://github.com/ExaDev/wire-mesh/commit/8e80f928415ccc87b23444a1c3513869ba6b21ed))

### Tests

* **sfu:** add createSfuCall orchestration coverage against fakes ([bd0e257](https://github.com/ExaDev/wire-mesh/commit/bd0e2575fe92117ca6a6a11155b9fe2cd37a7f38))
* **sfu:** add sdp-bridge coverage against a realistic Chrome-shaped offer ([ada6ae4](https://github.com/ExaDev/wire-mesh/commit/ada6ae489809e8b356cc07dc28959bfd0af918fc))
* **sfu:** verify the mediasoup backend against a real Worker ([ec0c84c](https://github.com/ExaDev/wire-mesh/commit/ec0c84c97d28ea5685c44f4713c1569da3a502b9))

### Build System

* **ts:** release the workspace through @exadev/semantic-release-workspace ([650a0f5](https://github.com/ExaDev/wire-mesh/commit/650a0f560b620f35716548c77120ef970d535dd9))


### Dependencies

- Updated wire-mesh-core to 1.58.3
- Updated wire-mesh to 1.0.2
