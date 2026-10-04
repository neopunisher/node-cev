// The `js` examples in README.md and llms.txt, typechecked against the real
// types and run on the mock backend: no weights, no network.
//
// Each example becomes a module in test/.snippets/ with its text unchanged
// and on the same line numbers as in the document, so a compiler error at
// `README.md.L19.ts(27,3)` is line 27 of README.md. The example values in
// the comments (`// 'tech'`) are a real model's and are not checked.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cev } from '../src/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', '.snippets');
const DOCS = ['README.md', 'llms.txt'];

// What an example may use without declaring it: the fragments further down a
// document carry on from its first example. A new name goes here and in
// `context()` below.
const PARAMS = [
  "cev: import('../../src/index.ts').Cev",
  'state: unknown',
  'criteria: Record<string, string>',
  'id: string',
  'writeFile: (path: string, data: string) => Promise<void>',
].join(', ');

interface Snippet {
  /** `README.md:19`, the line of the opening fence. */
  name: string;
  file: string;
}

function snippets(doc: string): Snippet[] {
  const lines = readFileSync(join(ROOT, doc), 'utf8').split('\n');
  const found: Snippet[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '```js') continue;
    const end = lines.indexOf('```', i + 1);
    assert.ok(end > i, `${doc}:${i + 1}: unclosed code fence`);
    // Imports move to the top of the module; the package name becomes the sources.
    const imports: string[] = [];
    const body = lines.slice(i + 1, end).map((line) => {
      if (!line.startsWith('import ')) return line;
      imports.push(line.replace(/'cev-node'/, "'../../src/index.ts'"));
      return '';
    });
    // The inner block lets an example declare its own `cev`.
    const head = `${imports.join(' ')} export default async function (${PARAMS}) {{`;
    const file = join(OUT, `${doc}.L${i + 1}.ts`);
    writeFileSync(file, [head, ...Array<string>(i).fill(''), ...body, '}}', ''].join('\n'));
    found.push({ name: `${doc}:${i + 1}`, file });
    i = end;
  }
  return found;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.json', include: ['*.ts'] }));
const SNIPPETS = DOCS.flatMap(snippets);

// `Cev.load` in an example gets the mock backend; its options are still typechecked.
const opened: Cev[] = [];
before(() => {
  mock.method(Cev, 'load', async () => {
    const cev = await Cev.mock();
    opened.push(cev);
    return cev;
  });
});
after(() => {
  mock.restoreAll();
  for (const cev of opened) cev.close();
  rmSync(OUT, { recursive: true, force: true });
});

/** A mock instance with one decision in its log, and the other names in `PARAMS`. */
async function context() {
  const cev = await Cev.load();
  const state = { ticket: 'The app crashes when I tap Log in' };
  const criteria = { billing: 'Payments, invoices, refunds', tech: 'Bugs, crashes, error messages' };
  const res = await cev.decide({
    state,
    questions: { team: { type: 'choice', instructions: 'Which team?', criteria, task: 'router.team' } },
  });
  const written: string[] = [];
  const writeFile = async (_path: string, data: string) => void written.push(data);
  return [cev, state, criteria, res.answers.team.x_cev.decision_id, writeFile] as const;
}

test('the documents have examples', () => {
  for (const doc of DOCS) assert.ok(SNIPPETS.some((s) => s.name.startsWith(`${doc}:`)), `no js example found in ${doc}`);
});

test('the examples typecheck', () => {
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const run = spawnSync(process.execPath, [tsc, '-p', OUT, '--pretty', 'false'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `an example in ${DOCS.join(' or ')} does not typecheck:\n${run.stdout}${run.stderr}`);
});

for (const snippet of SNIPPETS) {
  test(`${snippet.name} runs`, async () => {
    const { default: run } = (await import(pathToFileURL(snippet.file).href)) as {
      default: (...args: Awaited<ReturnType<typeof context>>) => Promise<void>;
    };
    await run(...(await context()));
  });
}
