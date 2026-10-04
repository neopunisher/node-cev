#!/usr/bin/env node
// Compile the Rust addon in native/ and put it where src/native.ts looks for
// it: cev.<platform>-<arch>[-<libc>].node in the package root.
//
//     node scripts/build-native.mjs [--features <list>] [--debug]
//
// macOS builds always include Metal and Accelerate (native/Cargo.toml); the
// default elsewhere is CPU-only. Pass `--features cuda` for NVIDIA GPUs.
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { features: { type: 'string' }, debug: { type: 'boolean' } } });
const features = values.features ?? process.env.CEV_FEATURES ?? '';
const profile = values.debug ? 'debug' : 'release';

const args = ['build', '--manifest-path', join(root, 'native', 'Cargo.toml'), '--locked'];
if (!values.debug) args.push('--release');
if (features) args.push('--features', features);
console.error(`cargo ${args.join(' ')}`);
const { status } = spawnSync('cargo', args, { stdio: 'inherit' });
if (status !== 0) process.exit(status ?? 1);

const built = { darwin: 'libnode_cev.dylib', win32: 'node_cev.dll' }[process.platform] ?? 'libnode_cev.so';
// Keep in step with target() in src/native.ts.
let target = `${process.platform}-${process.arch}`;
if (process.platform === 'linux') target += process.report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl';
const out = join(root, `cev.${target}.node`);
copyFileSync(join(root, 'native', 'target', profile, built), out);
console.error(out);
