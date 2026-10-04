# AGENTS.md

Guidance for AI coding agents working in this repository. User-facing API
docs for agents live in `llms.txt` (shipped in the npm package); keep it in
sync when the public API or the options change.

## What this is

A Node.js binding for [cev](https://github.com/CarterCole/rust-cev). The
engine, the decision log and the online learner are Rust crates in that
repository (`cev-core`, `cev-model`, `cev-runtime`) and are published on their
own. This repository holds only the glue: a napi addon and a typed wrapper.
Nothing from the engine is copied here. A change to prompts, model code,
storage or learning belongs in rust-cev.

## Layout

- `native/` — the addon: a Rust crate (`native/src/lib.rs`) that wraps
  `cev_runtime::Cev` behind a class whose methods take and return JSON text.
  It owns the threads: `concurrency` workers for forward passes, one for
  feedback and log reads, and the size of rayon's global pool (`threads`).
- `src/native.ts` — finds and loads `cev.<platform>-<arch>.node`.
- `src/types.ts` — the wire types (cev's REST bodies) and the option types.
- `src/index.ts` — `Cev`, `CevError`, `info()`.
- `scripts/build-native.mjs` — `cargo build` plus the copy into the package root.
- `scripts/bench.mjs` — latency and throughput for one configuration.
- `test/*.test.ts` — `node:test` suites, run directly from TypeScript against
  the mock backend.
- `dist/`, `cev.*.node`, `native/target/` — build output; gitignored.

## Commands

```bash
npm run build:native      # cargo build -> cev.<platform>-<arch>.node (needs ../rust-cev)
npm run build:ts          # src/ -> dist/
npm run typecheck         # tsc, no emit
npm test                  # node --test on the .ts sources; needs the addon built
npm run bench -- --device cpu --threads 8      # needs `npm run build` and model weights
CEV_TEST_MODEL=Qwen/Qwen3-0.6B npm test        # also run the real-model test
```

Run `npm run build:native && npm run typecheck && npm test` before calling a
change done.

## Rules

- **Zero runtime dependencies.** Dev dependencies are fine. The addon is
  loaded with `createRequire`; there is no generated loader.
- Node >= 22, ESM only. Sources use Node's native type stripping, so only
  erasable TypeScript syntax (`erasableSyntaxOnly`): no enums, namespaces or
  parameter properties. Import siblings with the `.ts` extension; the build
  rewrites them to `.js`.
- Requests and responses keep cev's wire format, snake_case included, so they
  match the REST API and the exported training rows. Only `Cev.load` /
  `Cev.mock` options are camelCase; a new one needs a field in `Options`
  (`native/src/lib.rs`), a property in `src/types.ts`, a README options-table
  row and an `llms.txt` mention.
- The JavaScript thread only queues work. Anything that runs the model or
  touches SQLite goes through `Cev::submit` onto a worker thread and settles a
  promise; do not add synchronous methods that do either.
- Addon errors are `<code>: <message>` strings; `src/index.ts` turns the code
  into `CevError.code`. Keep the two lists of codes in step.
- Tests must not need weights or the network: use `Cev.mock()`. Tests that
  need a model are skipped unless `CEV_TEST_MODEL` is set.
- Benchmark numbers in the README come from `scripts/bench.mjs` on the machine
  named there. Re-measure rather than extrapolate when changing them.
- User-visible changes get a `CHANGELOG.md` entry.

## Releasing

Not automated yet: there are no prebuilt binaries on npm, so the package is
built from source. Publishing needs the cev crates on crates.io first (then
drop the `path` keys in `native/Cargo.toml`) and a CI job that builds
`cev.<platform>-<arch>.node` per platform.
