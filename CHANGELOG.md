# Changelog

## Unreleased

Takes cev 0.2.1.

### Added
- `Cev.load({ model })` runs the open decision models natively: Bespoke Nimble,
  Kev, d3, d1 and d1-omni, plus Qwen3.5 checkpoints. Short names work
  (`kev:0.8b`, `d1-omni`, `nimble-v3`, ...); the family is detected from the
  repository's files.
- `images` and `audio` on `decide()` and `examples()`, as bytes (`Buffer`,
  `Uint8Array`) or base64, for models that take them.
- `cev.model.family` and `cev.model.modalities`.
- Namespaces: `namespace` on `decide()` and `examples()` keeps feedback and
  adapters apart. `tasks(namespace?)`, `resetTask(task, namespace?)`,
  `decisions({ namespace })` and `export({ namespace })` read one namespace.
- `Cev.mock({ media: true })`, which accepts images and audio.

### Changed
- `debias` defaults to `auto`: `full` for zero-shot code readouts as before,
  `none` for the trained decision models.

## 0.1.0 (2026-10-03)

First version: cev in-process for Node.js.

### Added
- `Cev.load()`: a Qwen3 checkpoint from a directory or the Hugging Face cache,
  run by a native addon over the cev Rust crates. Metal and Apple's Accelerate
  BLAS on macOS, portable multi-threaded kernels elsewhere, CUDA as a build
  feature.
- `decide()`, typed from the questions: a choice answer knows its option names.
- `feedback()`, `examples()`, `tasks()`, `resetTask()`: labels and the online
  adapters that learn from them.
- `decisions()`, `decision()`, `export()`, `exportNdjson()`, `stats()`: the
  decision log, in memory or in a SQLite file (`db`).
- `Cev.mock()`: the whole API without weights, for tests.
- `threads` and `concurrency` options, `info()`, and `scripts/bench.mjs`.
- Prebuilt addons in the npm package for macOS arm64 and Linux x64 and arm64
  (glibc 2.28 or newer). The addon's sources ship too, for building on other
  platforms or with CUDA.
