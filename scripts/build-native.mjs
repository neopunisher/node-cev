#!/usr/bin/env node
// Compile the Rust addon in native/ and put it where src/native.ts looks for
// it: cev.<platform>-<arch>[-<libc>].node in the package root.
//
//     node scripts/build-native.mjs [--features <list>] [--engine <dir>] [--debug]
//
// macOS builds always include Metal and Accelerate (native/Cargo.toml); the
// default elsewhere is CPU-only. Pass `--features cuda` for NVIDIA GPUs.
// The engine comes from crates.io at the versions in native/Cargo.lock;
// `--engine ../rust-cev` builds against a checkout instead.
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { features: { type: 'string' }, engine: { type: 'string' }, debug: { type: 'boolean' } } });
const features = values.features ?? process.env.CEV_FEATURES ?? '';
const engine = values.engine ?? process.env.CEV_ENGINE ?? '';
const profile = values.debug ? 'debug' : 'release';

const args = ['build', '--manifest-path', join(root, 'native', 'Cargo.toml')];
if (!values.debug) args.push('--release');
if (features) args.push('--features', features);
if (engine) {
  for (const crate of ['cev-core', 'cev-model', 'cev-runtime']) {
    args.push('--config', `patch.crates-io.${crate}.path=${JSON.stringify(resolve(engine, 'crates', crate))}`);
  }
} else {
  args.push('--locked');
}
console.error(`cargo ${args.join(' ')}`);
// A patched build rewrites the lockfile to point at the checkout; put the
// committed one back so the next plain build is the published engine again.
const lock = join(root, 'native', 'Cargo.lock');
const locked = readFileSync(lock);
const { status } = spawnSync('cargo', args, { stdio: 'inherit' });
if (engine) writeFileSync(lock, locked);
if (status !== 0) process.exit(status ?? 1);

const built = { darwin: 'libnode_cev.dylib', win32: 'node_cev.dll' }[process.platform] ?? 'libnode_cev.so';
// Keep in step with target() in src/native.ts.
let target = `${process.platform}-${process.arch}`;
if (process.platform === 'linux') target += process.report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl';
const out = join(root, `cev.${target}.node`);
copyFileSync(join(root, 'native', 'target', profile, built), out);
console.error(out);
