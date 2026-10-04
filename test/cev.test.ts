// Everything here runs on the mock backend: no weights, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Cev, CevError, info, type ChoiceAnswer, type Questions } from '../src/index.ts';

const TICKET = { subject: 'App crashes on login', body: 'The app shows an error and crashes when I tap Log in.' };
const QUESTIONS = {
  team: {
    type: 'choice',
    instructions: 'Which team should handle this ticket?',
    criteria: { billing: 'Payments, invoices, refunds', tech: 'Bugs, crashes, error messages' },
    task: 'router.team',
  },
  refund: { type: 'noul', instructions: 'Is the customer asking for a refund?' },
  severity: { type: 'score', instructions: 'How severe is the issue?', criteria: ['Cosmetic', 'Degraded', 'Blocking'] },
} as const satisfies Questions;

const sum = (p: Record<string, number>) => Object.values(p).reduce((a, b) => a + b, 0);

async function rejects(promise: Promise<unknown>, code: CevError['code']): Promise<void> {
  await assert.rejects(promise, (e) => e instanceof CevError && e.code === code, `expected a CevError with code ${code}`);
}

test('info describes the build', () => {
  const i = info();
  assert.match(i.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof i.metal, 'boolean');
  assert.ok(i.cores >= 1);
});

test('decide answers every question with its type', async () => {
  const cev = await Cev.mock();
  assert.equal(cev.model.id, 'cev-mock');
  assert.ok(cev.model.threads >= 1);

  const res = await cev.decide({ state: TICKET, questions: QUESTIONS });
  assert.deepEqual(Object.keys(res.answers), ['team', 'refund', 'severity']);
  assert.match(res.request_id, /^req_/);

  // The option names are part of the type: `choice` is 'billing' | 'tech'.
  const team: ChoiceAnswer<'billing' | 'tech'> = res.answers.team;
  assert.equal(team.choice, 'tech');
  assert.ok(Math.abs(sum(team.probabilities) - 1) < 1e-5);
  assert.ok(team.confidence > 0 && team.confidence <= 1);
  assert.match(team.x_cev.decision_id, /^dec_/);
  assert.equal(team.x_cev.task, 'router.team');

  const { noul } = res.answers.refund;
  assert.ok(noul >= 0 && noul <= 1);

  const severity = res.answers.severity;
  assert.ok(severity.score >= 0 && severity.score <= 2);
  assert.deepEqual(severity.legend, { 0: 'Cosmetic', 1: 'Degraded', 2: 'Blocking' });
  assert.ok(Math.abs(sum(severity.probabilities) - 1) < 1e-5);
  cev.close();
});

test('state can be text, and criteria a list of names', async () => {
  const cev = await Cev.mock();
  const { answers } = await cev.decide({
    state: 'Please refund my last invoice.',
    questions: { kind: { type: 'choice', instructions: 'What is this about?', criteria: ['refund', 'bug', 'other'] } },
  });
  const kind: 'refund' | 'bug' | 'other' = answers.kind.choice;
  assert.equal(kind, 'refund');
  cev.close();
});

test('feedback is stored, learned from and exported', async () => {
  const cev = await Cev.mock();
  const res = await cev.decide({ state: TICKET, questions: QUESTIONS });

  const byId = await cev.feedback({ decision_id: res.answers.team.x_cev.decision_id, label: 'tech', comment: 'crash', metadata: { by: 'test' } });
  assert.equal(byId.task, 'router.team');
  assert.equal(byId.learned, true);
  assert.equal(byId.task_examples, 1);
  assert.equal(typeof byId.served_loss, 'number');

  const byQuestion = await cev.feedback({ request_id: res.request_id, question_id: 'severity', label: 2 });
  assert.equal(byQuestion.decision_id, res.answers.severity.x_cev.decision_id);

  const tasks = await cev.tasks();
  assert.deepEqual(tasks.find((t) => t.task === 'router.team')?.examples, 1);

  const detail = await cev.decision(res.answers.team.x_cev.decision_id);
  assert.ok(detail);
  assert.deepEqual(detail.state, TICKET);
  assert.ok(detail.prompt?.includes('Which team should handle this ticket?'));
  assert.equal(detail.feedback[0]?.comment, 'crash');
  assert.equal(await cev.decision('dec_missing'), null);

  assert.equal((await cev.decisions()).length, 3);
  assert.equal((await cev.decisions({ task: 'router.team' })).length, 1);

  const rows = await cev.export();
  assert.equal(rows.length, 2);
  const row = rows.find((r) => r.task === 'router.team');
  assert.deepEqual(row?.target, [0, 1]);
  assert.deepEqual(row?.options, ['billing', 'tech']);
  assert.equal((await cev.export({ labeled: false })).length, 3);
  const ndjson = await cev.exportNdjson({ task: 'router.team' });
  assert.equal(ndjson.trimEnd().split('\n').length, 1);
  assert.equal(JSON.parse(ndjson).decision_id, row?.decision_id);

  assert.deepEqual((await cev.stats()).store, { requests: 1, decisions: 3, feedback: 2, labeled_decisions: 2 });

  assert.equal(await cev.resetTask('router.team'), true);
  assert.equal(await cev.resetTask('router.team'), false);
  assert.equal((await cev.export()).length, 2, 'labels outlive the adapter');
  cev.close();
});

test('examples decide and then learn', async () => {
  const cev = await Cev.mock({ minExamples: 2 });
  const results = await cev.examples(
    ['The app crashes on launch', 'I was charged twice', 'Error 500 when saving', 'Refund my invoice please'].map((state, i) => ({
      state,
      questions: { team: QUESTIONS.team },
      labels: { team: i % 2 ? 'billing' : 'tech' },
    })),
  );
  assert.equal(results.length, 4);
  assert.equal(results[3]?.feedback[0]?.task_examples, 4);
  const [task] = await cev.tasks();
  assert.equal(task?.examples, 4);
  assert.equal(task?.buffered, 4);
  cev.close();
});

test('no_store answers cannot take feedback', async () => {
  const cev = await Cev.mock();
  const res = await cev.decide({ state: TICKET, questions: QUESTIONS, no_store: true, debias: 'none' });
  assert.equal(res.answers.team.x_cev.decision_id, '');
  assert.equal((await cev.stats()).store.decisions, 0);
  await rejects(cev.feedback({ request_id: res.request_id, question_id: 'team', label: 'tech' }), 'not_found');
  cev.close();
});

test('errors carry a code', async () => {
  const cev = await Cev.mock();
  await rejects(cev.decide({ state: 'x', questions: {} }), 'bad_request');
  await rejects(cev.decide({ state: 'x', questions: { q: { type: 'choice', instructions: 'Pick', criteria: ['only'] } } }), 'bad_request');
  await rejects(cev.feedback({ decision_id: 'dec_missing', label: true }), 'not_found');
  const res = await cev.decide({ state: TICKET, questions: QUESTIONS });
  await rejects(cev.feedback({ decision_id: res.answers.team.x_cev.decision_id, label: 'sales' }), 'bad_request');
  // @ts-expect-error unknown options are rejected by the types and by the addon
  await rejects(Cev.mock({ nope: 1 }), 'bad_request');
  cev.close();
  await rejects(cev.stats(), 'closed');
  await rejects(cev.decide({ state: TICKET, questions: QUESTIONS }), 'closed');
  cev.close();
});

test('calls made before close still settle', async () => {
  const cev = await Cev.mock();
  const pending = Array.from({ length: 50 }, (_, i) => cev.decide({ state: { ...TICKET, i }, questions: QUESTIONS }));
  cev.close();
  const done = await Promise.all(pending);
  assert.equal(new Set(done.map((r) => r.request_id)).size, 50);
});

test('the log persists in a database file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-cev-'));
  try {
    const db = join(dir, 'cev.db');
    const first = await Cev.mock({ db });
    const res = await first.decide({ state: TICKET, questions: QUESTIONS });
    await first.feedback({ decision_id: res.answers.team.x_cev.decision_id, label: 'tech' });
    first.close();

    const second = await Cev.mock({ db });
    assert.deepEqual((await second.stats()).store, { requests: 1, decisions: 3, feedback: 1, labeled_decisions: 1 });
    assert.equal((await second.tasks())[0]?.examples, 1, 'adapters are restored');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CEV_TEST_MODEL=Qwen/Qwen3-0.6B npm test   (needs the weights; downloads them if missing)
test('a real model routes a ticket', { skip: !process.env.CEV_TEST_MODEL }, async () => {
  const cev = await Cev.load({ model: process.env.CEV_TEST_MODEL });
  const { answers, usage } = await cev.decide({ state: TICKET, questions: QUESTIONS, no_store: true });
  assert.equal(answers.team.choice, 'tech');
  assert.ok(answers.refund.noul < 0.5);
  assert.ok(usage.input_tokens > 100);
  cev.close();
});
