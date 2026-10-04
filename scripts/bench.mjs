#!/usr/bin/env node
// Latency and throughput of the native addon. One configuration per run:
//
//     npm run build
//     node scripts/bench.mjs --model Qwen/Qwen3-0.6B --device cpu --threads 8
//
// The short request is the one rust-cev's scripts/bench.py and
// scripts/bench_web.mjs send (a ticket and 3 questions); the long one pads the
// state to about 2.3k tokens. "first" is the very first request (calibration
// not cached yet), "new state" changes the state every call, "same state"
// repeats it (prefix cached). Throughput sends new states, `--parallel` at a
// time.
import { parseArgs } from 'node:util';
import { Cev, info } from '../dist/index.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'Qwen/Qwen3-0.6B' },
    device: { type: 'string', default: 'auto' },
    dtype: { type: 'string' },
    threads: { type: 'string' },
    concurrency: { type: 'string' },
    debias: { type: 'string', default: 'calibrate,full' },
    runs: { type: 'string', default: '5' },
    parallel: { type: 'string', default: '8' },
    requests: { type: 'string', default: '32' },
    json: { type: 'boolean' },
  },
});
const num = (v) => (v === undefined ? undefined : Number(v));
const runs = Number(values.runs);

const QUESTIONS = {
  team: {
    type: 'choice',
    instructions: 'Which team should handle this ticket?',
    criteria: { billing: 'Payments, invoices, refunds', tech: 'Bugs, crashes, errors', sales: 'New purchases and upgrades' },
  },
  refund: { type: 'noul', instructions: 'Is the customer asking for a refund?' },
  severity: {
    type: 'score',
    instructions: 'How severe is the issue?',
    criteria: ['Cosmetic; no impact', 'Degraded, workaround exists', 'Blocking; no workaround'],
  },
};
const TICKET = { subject: 'App crashes on login', body: 'Since the update, the iOS app crashes as soon as I tap Log in.' };
const HISTORY = Array.from({ length: 40 }, (_, i) => ({
  at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T10:${String(i).padStart(2, '0')}:00Z`,
  from: i % 2 ? 'agent' : 'customer',
  text: `Follow-up ${i}: still seeing the crash after reinstalling, clearing the cache and restarting the phone. Build 4.${i}.`,
}));

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const ms = (v) => v.toFixed(0).padStart(5);

const t0 = performance.now();
const cev = await Cev.load({
  model: values.model,
  device: values.device,
  dtype: values.dtype,
  threads: num(values.threads),
  concurrency: num(values.concurrency),
});
const loadMs = performance.now() - t0;
const { threads, concurrency } = cev.model;
const out = { model: values.model, device: values.device, threads, concurrency, loadMs, info: info(), latency: [], throughput: [] };
if (!values.json) {
  console.log(`${values.model} on ${values.device}: loaded in ${(loadMs / 1000).toFixed(1)} s, ${threads} threads, concurrency ${concurrency}`);
}

let nonce = 0;
const decide = async (state, debias) => {
  const t = performance.now();
  const r = await cev.decide({ state, questions: QUESTIONS, debias, no_store: true });
  return [performance.now() - t, r.usage.input_tokens];
};
const timed = async (n, state, debias) => {
  const xs = [];
  for (let i = 0; i < n; i++) xs.push((await decide(state(), debias))[0]);
  return median(xs);
};

for (const debias of values.debias.split(',')) {
  for (const [name, base] of [['short', TICKET], ['long', { ...TICKET, history: HISTORY }]]) {
    const fresh = () => ({ ...base, nonce: `run-${nonce++}` });
    const [first, tokens] = await decide(fresh(), debias);
    const uncached = await timed(runs, fresh, debias);
    const state = fresh();
    await decide(state, debias);
    const cached = await timed(runs, () => state, debias);
    out.latency.push({ debias, state: name, tokens, first, uncached, cached });
    if (!values.json) {
      console.log(`  ${debias.padEnd(9)} ${name.padEnd(5)} ${String(tokens).padStart(5)} tok: first ${ms(first)} ms, new state ${ms(uncached)} ms, same state ${ms(cached)} ms`);
    }
  }
  // Throughput: short tickets, new state each, `parallel` in flight.
  const total = Number(values.requests);
  let next = 0;
  const t = performance.now();
  await Promise.all(
    Array.from({ length: Number(values.parallel) }, async () => {
      while (next++ < total) await decide({ ...TICKET, nonce: `run-${nonce++}` }, debias);
    }),
  );
  const perSec = total / ((performance.now() - t) / 1000);
  out.throughput.push({ debias, parallel: Number(values.parallel), perSec });
  if (!values.json) console.log(`  ${debias.padEnd(9)} throughput: ${perSec.toFixed(1)} requests/s with ${values.parallel} in flight`);
}
cev.close();
if (values.json) console.log(JSON.stringify(out));
