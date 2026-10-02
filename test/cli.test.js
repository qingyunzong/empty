import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// NOTE: in this sandbox a spawned node process's stdout pipe is not
// captured by spawnSync, so we redirect through bash into files instead.
function run(args, cwd) {
  const outFile = join(cwd, '.stdout');
  const errFile = join(cwd, '.stderr');
  const codeFile = join(cwd, '.exitcode');
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cmd = [process.execPath, CLI, ...args].map(quote).join(' ');
  spawnSync(
    'bash',
    ['-c', `${cmd} >${quote(outFile)} 2>${quote(errFile)}; printf %s $? >${quote(codeFile)}`],
    { cwd, encoding: 'utf8' },
  );
  return {
    status: Number(readFileSync(codeFile, 'utf8')),
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8'),
  };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'cea-'));
}

const E1 = JSON.stringify({ id: 'e1', device: 'A', ts: 0, vc: { A: 1 }, type: 'RUN' });
const E2 = JSON.stringify({ id: 'e2', device: 'A', ts: 10, vc: { A: 2 }, type: 'STOP' });

test('add with malformed JSON exits 2', () => {
  const res = run(['add', '{not json'], tmp());
  assert.equal(res.status, 2);
  assert.match(res.stderr, /error:/);
});

test('duplicate id exits 2', () => {
  const dir = tmp();
  assert.equal(run(['add', E1], dir).status, 0);
  const res = run(['add', E1], dir);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /duplicate event id/);
});

test('illegal vector clock exits 2', () => {
  for (const vc of ['{"A":-1}', '{"A":1.5}', '[1]', '"x"']) {
    const bad = JSON.stringify({ id: 'e1', device: 'A', ts: 0, vc: JSON.parse(vc), type: 'RUN' });
    const res = run(['add', bad], tmp());
    assert.equal(res.status, 2, `vc=${vc}`);
    assert.match(res.stderr, /vc/);
  }
});

test('invalid store file exits 2', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'events.json'), '{broken');
  assert.equal(run(['solve'], dir).status, 2);
  writeFileSync(join(dir, 'events.json'), '{"not":"an array"}');
  assert.equal(run(['solve'], dir).status, 2);
});

test('add + solve happy path prints feasible order', () => {
  const dir = tmp();
  assert.equal(run(['add', E1], dir).status, 0);
  assert.equal(run(['add', E2], dir).status, 0);
  const res = run(['solve', '--budget', '100'], dir);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'feasible');
  assert.deepEqual(out.order, ['e1', 'e2']);
  assert.equal(out.unique, true);
});

test('retract removes events; unknown id exits 1', () => {
  const dir = tmp();
  run(['add', E1], dir);
  assert.equal(run(['retract', 'e1'], dir).status, 0);
  assert.equal(run(['retract', 'e1'], dir).status, 1);
  const res = run(['solve'], dir);
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout).order, []);
});

test('infeasible log surfaces conflict chain through the CLI', () => {
  const dir = tmp();
  run(['add', JSON.stringify({ id: 's', device: 'M', ts: 0, vc: { M: 1 }, type: 'STOP' })], dir);
  run(['add', JSON.stringify({ id: 'r', device: 'M', ts: 1, vc: { M: 2 }, type: 'RUN' })], dir);
  const res = run(['solve', '--budget', '10'], dir);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'infeasible');
  assert.equal(out.conflict.rule, 'reset-before-run');
  assert.deepEqual(out.conflict.events.sort(), ['r', 's']);
});

test('--store selects an alternate store file', () => {
  const dir = tmp();
  const store = join(dir, 'alt.json');
  assert.equal(run(['add', E1, '--store', store], dir).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(store, 'utf8')).map((e) => e.id), ['e1']);
});
