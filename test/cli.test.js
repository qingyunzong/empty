import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

function setup(files) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-cli-'));
  const paths = {};
  for (const [name, lines] of Object.entries(files)) {
    paths[name] = join(dir, name);
    writeFileSync(paths[name], lines);
  }
  return { dir, paths };
}

function run(args) {
  return runCli(args);
}

const BASE = [
  JSON.stringify({ id: 'a1', account: 'ACC-1', amount: 100, ccy: 'USD', seq: 1, status: 'DRAFT' }),
  JSON.stringify({ id: 'a2', account: 'ACC-2', amount: 50, ccy: 'EUR', seq: 2, status: 'LOCKED' }),
].join('\n') + '\n';

test('CLI: clean merge writes sorted result and empty conflicts, exit 0', () => {
  const { dir, paths } = setup({
    'base.jsonl': BASE,
    'left.jsonl': BASE.replace('"amount":100', '"amount":150'),
    'right.jsonl': BASE,
  });
  const out = join(dir, 'result.jsonl');
  const conflictsPath = join(dir, 'conflicts.json');
  const proc = run([paths['base.jsonl'], paths['left.jsonl'], paths['right.jsonl'], '--out', out, '--conflicts', conflictsPath]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /^merged=2 conflicts=0 /);
  const lines = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((r) => r.id), ['a1', 'a2']);
  assert.equal(lines[0].amount, 150);
  assert.deepEqual(JSON.parse(readFileSync(conflictsPath, 'utf8')), { conflicts: [] });
});

test('CLI: conflicted record withheld; conflict file carries summaries, rule, sha256', () => {
  const left = BASE.replace('"amount":100', '"amount":200');
  const right = BASE.replace('"amount":100', '"amount":300');
  const { dir, paths } = setup({ 'base.jsonl': BASE, 'left.jsonl': left, 'right.jsonl': right });
  const out = join(dir, 'result.jsonl');
  const conflictsPath = join(dir, 'conflicts.json');
  const proc = run([paths['base.jsonl'], paths['left.jsonl'], paths['right.jsonl'], '--out', out, '--conflicts', conflictsPath]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /^merged=1 conflicts=1 /);
  const lines = readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((r) => r.id), ['a2']);
  const { conflicts } = JSON.parse(readFileSync(conflictsPath, 'utf8'));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].rule, 'R1');
  assert.equal(conflicts[0].base.amount, 100);
  assert.equal(conflicts[0].left.amount, 200);
  assert.equal(conflicts[0].right.amount, 300);
  assert.match(conflicts[0].sha256, /^[0-9a-f]{64}$/);
});

test('CLI: bad JSONL exits 2 with {code,line,msg} on stderr', () => {
  const { paths } = setup({
    'base.jsonl': BASE,
    'left.jsonl': '{"id":"a1"\n',
    'right.jsonl': BASE,
  });
  const proc = run([paths['base.jsonl'], paths['left.jsonl'], paths['right.jsonl']]);
  assert.equal(proc.status, 2);
  const err = JSON.parse(proc.stderr.trim());
  assert.equal(err.code, 'BAD_JSONL');
  assert.equal(err.line, 1);
  assert.equal(typeof err.msg, 'string');
});

test('CLI: duplicate id exits 2', () => {
  const dup = BASE + BASE.split('\n')[0] + '\n';
  const { paths } = setup({ 'base.jsonl': BASE, 'left.jsonl': dup, 'right.jsonl': BASE });
  const proc = run([paths['base.jsonl'], paths['left.jsonl'], paths['right.jsonl']]);
  assert.equal(proc.status, 2);
  const err = JSON.parse(proc.stderr.trim());
  assert.equal(err.code, 'DUP_ID');
  assert.equal(err.line, 3);
});

test('CLI: illegal status transition exits 2', () => {
  const jumped = BASE.replace('"status":"DRAFT"', '"status":"SETTLED"');
  const { paths } = setup({ 'base.jsonl': BASE, 'left.jsonl': jumped, 'right.jsonl': BASE });
  const proc = run([paths['base.jsonl'], paths['left.jsonl'], paths['right.jsonl']]);
  assert.equal(proc.status, 2);
  const err = JSON.parse(proc.stderr.trim());
  assert.equal(err.code, 'ILLEGAL_TRANSITION');
  assert.equal(err.line, 1);
  assert.match(err.msg, /DRAFT->SETTLED/);
});

test('CLI: missing input file exits 2 with IO code', () => {
  const { paths } = setup({ 'base.jsonl': BASE, 'left.jsonl': BASE, 'right.jsonl': BASE });
  const proc = run([paths['base.jsonl'], '/nonexistent/left.jsonl', paths['right.jsonl']]);
  assert.equal(proc.status, 2);
  assert.equal(JSON.parse(proc.stderr.trim()).code, 'IO');
});
