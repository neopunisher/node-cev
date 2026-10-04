# Changelog

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
