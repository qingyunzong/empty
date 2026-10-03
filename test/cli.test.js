import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { tmpdir } from './helpers.js';

// The CLI is exercised in-process: runCli(argv, io) returns the exact exit
// code the wrapper passes to process.exit, and captures the JSON it prints.
function run(dir, cmd, args) {
  let text = '';
  const argv = [dir, cmd];
  if (args !== undefined) argv.push(JSON.stringify(args));
  const code = runCli(argv, { stdout: (s) => { text += s; }, readStdin: () => '' });
  return { code, body: text.trim() ? JSON.parse(text) : null };
}

test('CLI exec: full transaction with savepoints, JSON output, certificates', () => {
  const dir = tmpdir();
  const script = [
    { cmd: 'begin' },
    { cmd: 'create', args: { id: 'A', weight: 100 } },
    { cmd: 'savepoint', args: { name: 's1' } },
    { cmd: 'split', args: { parents: ['A'], children: [{ id: 'B', weight: 40 }] } },
    { cmd: 'rollback', args: { name: 's1' } },
    { cmd: 'split', args: { parents: ['A'], children: [{ id: 'C', weight: 30 }] } },
    { cmd: 'status', args: { id: 'C', status: 'passed' } },
    { cmd: 'commit' },
  ];
  const res = run(dir, 'exec', script);
  assert.equal(res.code, 0);
  assert.equal(res.body.ok, true);
  const committed = res.body.results.at(-1);
  assert.equal(committed.committed, 1);
  assert.deepEqual(Object.keys(committed.certificates).sort(), ['A', 'C']);

  const anc = run(dir, 'ancestors', { id: 'C' });
  assert.deepEqual(anc.body.result.ancestors, ['A']);
  const cert = run(dir, 'certificate', { id: 'C' });
  assert.equal(cert.body.result.certificate, committed.certificates.C);
  const kids = run(dir, 'children', { id: 'A' });
  assert.deepEqual(kids.body.result.children, ['C']);
});

test('CLI business errors exit 1', () => {
  const dir = tmpdir();
  assert.equal(run(dir, 'create', { id: 'A', weight: 10 }).code, 0);
  const over = run(dir, 'split', { parents: ['A'], children: [{ id: 'B', weight: 99 }] });
  assert.equal(over.code, 1);
  assert.equal(over.body.error.type, 'business');
  assert.equal(run(dir, 'get', { id: 'ghost' }).code, 1);
  assert.equal(run(dir, 'status', { id: 'A', status: 'nope' }).code, 1);
});

test('CLI corruption exits 2', () => {
  const dir = tmpdir();
  assert.equal(run(dir, 'create', { id: 'A', weight: 10 }).code, 0);
  assert.equal(run(dir, 'create', { id: 'B', weight: 5 }).code, 0);
  const walPath = path.join(dir, 'wal.log');
  const wal = fs.readFileSync(walPath, 'utf8');
  fs.writeFileSync(walPath, wal.replace('"weight":10', '"weight":11')); // break a mid-file checksum
  const res = run(dir, 'state');
  assert.equal(res.code, 2);
  assert.equal(res.body.error.type, 'corruption');
});

test('CLI single mutations auto-commit and survive restart', () => {
  const dir = tmpdir();
  assert.equal(run(dir, 'create', { id: 'A', weight: 100 }).code, 0);
  assert.equal(run(dir, 'split', { parents: ['A'], children: [{ id: 'B', weight: 25 }] }).code, 0);
  const state = run(dir, 'state');
  assert.equal(state.code, 0);
  assert.deepEqual(state.body.result.batches.map((b) => b.id), ['A', 'B']);
  assert.equal(state.body.result.batches[0].effective, 75);
});

test('CLI reads JSON from stdin when arg is -', () => {
  const dir = tmpdir();
  let text = '';
  const code = runCli([dir, 'create', '-'], {
    stdout: (s) => { text += s; },
    readStdin: () => '{"id":"S","weight":7}',
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(text).ok, true);
});
