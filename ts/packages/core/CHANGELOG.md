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
