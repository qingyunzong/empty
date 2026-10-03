// CLI integration: real subprocess runs, real exit codes and outputs.
// Exit codes: 0 feasible/ok, 1 infeasible, 2 invalid input/usage, 3 unknown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

// The sandbox blocks node from exec'ing node directly (EPERM) and swallows
// grandchild stdout on pipes, so run the CLI through a shell, redirect
// stdout/stderr to files, and read the real exit code from the shell.
function runCli(args) {
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const dir = mkdtempSync(join(tmpdir(), 'trace-run-'));
  const outFile = join(dir, 'stdout');
  const errFile = join(dir, 'stderr');
  const cmd =
    [process.execPath, CLI, ...args].map(quote).join(' ') +
    ` >${quote(outFile)} 2>${quote(errFile)}; printf '%s' "$?"`;
  const r = spawnSync('/bin/bash', ['-c', cmd], { encoding: 'utf8' });
  if (r.status === null) throw r.error ?? new Error('spawn failed');
  return {
    code: Number(r.stdout.trim()),
    stdout: readFileSync(outFile, 'utf8').trim(),
    stderr: readFileSync(errFile, 'utf8').trim(),
  };
}

function fixture(t, name, input) {
  const dir = mkdtempSync(join(tmpdir(), 'trace-cli-'));
  const inputPath = join(dir, name);
  writeFileSync(inputPath, typeof input === 'string' ? input : JSON.stringify(input));
  return { dir, inputPath, state: join(dir, 'state.json') };
}

const FEASIBLE = {
  batches: [
    { id: 'M1', kind: 'material', quantity: 40, expiry: '2026-06-01' },
    { id: 'M2', kind: 'material', quantity: 30, expiry: '2026-05-01' },
    { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-03', outputQty: 45, loss: 5, expiry: '2026-04-01', candidates: ['M1', 'M2'] },
  ],
};

test('trace feasible -> exit 0 with genealogy', (t) => {
  const { inputPath, state } = fixture(t, 'ok.json', FEASIBLE);
  const r = runCli(['trace', inputPath, '--state', state]);
  t.diagnostic(`exit=${r.code} stdout=${r.stdout}`);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'feasible');
  const total = out.edges.reduce((s, e) => s + e.quantity, 0);
  assert.equal(total, 50); // outputQty 45 + loss 5
});

test('trace infeasible -> exit 1 with conflict proof', (t) => {
  const { inputPath, state } = fixture(t, 'bad.json', {
    batches: [
      { id: 'M1', kind: 'material', quantity: 5, expiry: '2026-06-01' },
      { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-03', outputQty: 45, loss: 5, expiry: '2026-04-01', candidates: ['M1'] },
    ],
  });
  const r = runCli(['trace', inputPath, '--state', state]);
  t.diagnostic(`exit=${r.code} stdout=${r.stdout}`);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'infeasible');
  assert.ok(out.proof.constraints.includes('input-sum'));
  assert.ok(out.proof.batches.includes('P1'));
  assert.ok(out.proof.batches.includes('M1'));
});

test('budget exhausted -> exit 3, status unknown with pending choices', (t) => {
  const input = {
    budget: 1000,
    batches: [
      { id: 'M1', kind: 'material', quantity: 10, expiry: '2026-06-01' },
      { id: 'M2', kind: 'material', quantity: 10, expiry: '2026-06-01' },
      { id: 'M3', kind: 'material', quantity: 10, expiry: '2026-06-01' },
      { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-03', outputQty: 8, loss: 1, expiry: '2026-04-01', candidates: ['M1', 'M2', 'M3'] },
    ],
  };
  const { inputPath, state } = fixture(t, 'tight.json', input);
  const r = runCli(['trace', inputPath, '--state', state, '--budget', '1']);
  t.diagnostic(`exit=${r.code} stdout=${r.stdout}`);
  assert.equal(r.code, 3);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'unknown');
  assert.ok(out.pending, 'pending choices must be listed');
  assert.deepEqual(out.pending.undecided, ['P1']);
  assert.equal(out.pending.interruptedBatch, 'P1');
});

test('invalid quantities -> exit 2', (t) => {
  const cases = [
    ['negative quantity', { id: 'M1', kind: 'material', quantity: -5, expiry: '2026-06-01' }],
    ['fractional quantity', { id: 'M1', kind: 'material', quantity: 1.5, expiry: '2026-06-01' }],
    ['zero outputQty', { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-02', outputQty: 0, loss: 0, expiry: '2026-04-01', candidates: [] }],
    ['negative loss', { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-02', outputQty: 3, loss: -1, expiry: '2026-04-01', candidates: [] }],
  ];
  for (const [name, batch] of cases) {
    const { inputPath, state } = fixture(t, 'invalid.json', { batches: [batch] });
    const r = runCli(['trace', inputPath, '--state', state]);
    t.diagnostic(`${name}: exit=${r.code} stderr=${r.stderr}`);
    assert.equal(r.code, 2, name);
    assert.ok(JSON.parse(r.stderr).error, name);
  }
});

test('broken references and structural errors -> exit 2', (t) => {
  const broken = {
    batches: [
      { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-02', outputQty: 3, loss: 0, expiry: '2026-04-01', candidates: ['GHOST'] },
    ],
  };
  const r1 = runCli(['trace', fixture(t, 'broken.json', broken).inputPath, '--state', join(mkdtempSync(join(tmpdir(), 'x-')), 's.json')]);
  t.diagnostic(`broken ref: exit=${r1.code} stderr=${r1.stderr}`);
  assert.equal(r1.code, 2);
  assert.match(r1.stderr, /broken candidate reference/);

  const cyclic = {
    batches: [
      { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-02', outputQty: 3, loss: 0, expiry: '2026-04-01', candidates: ['P2'] },
      { id: 'P2', kind: 'production', line: 'L1', start: '2026-02-03', end: '2026-02-04', outputQty: 3, loss: 0, expiry: '2026-04-01', candidates: ['P1'] },
    ],
  };
  const r2 = runCli(['trace', fixture(t, 'cyclic.json', cyclic).inputPath, '--state', join(mkdtempSync(join(tmpdir(), 'x-')), 's.json')]);
  t.diagnostic(`cycle: exit=${r2.code} stderr=${r2.stderr}`);
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /cycle/);

  const r3 = runCli(['trace', '/nonexistent/input.json']);
  t.diagnostic(`missing file: exit=${r3.code} stderr=${r3.stderr}`);
  assert.equal(r3.code, 2);
});

test('undo/redo through the CLI restores and replays the trace', (t) => {
  const { inputPath, state } = fixture(t, 'ok.json', FEASIBLE);
  const trace = runCli(['trace', inputPath, '--state', state]);
  assert.equal(trace.code, 0);
  const solved = JSON.parse(readFileSync(state, 'utf8'));
  const edgesAfterSolve = solved.state.edges.length;
  assert.ok(edgesAfterSolve > 0);

  const undo1 = runCli(['undo', '--state', state]);
  t.diagnostic(`undo solve: exit=${undo1.code} stdout=${undo1.stdout}`);
  assert.equal(undo1.code, 0);
  let out = JSON.parse(undo1.stdout);
  assert.equal(out.undo, 'solve');
  assert.equal(out.edges, 0, 'undo must remove genealogy edges');
  assert.deepEqual(out.derived, [], 'undo must remove propagation conclusions');

  const undo2 = runCli(['undo', '--state', state]);
  t.diagnostic(`undo load: exit=${undo2.code} stdout=${undo2.stdout}`);
  assert.equal(JSON.parse(undo2.stdout).batches, 0);

  const redo1 = runCli(['redo', '--state', state]);
  const redo2 = runCli(['redo', '--state', state]);
  t.diagnostic(`redo: exit=${redo2.code} stdout=${redo2.stdout}`);
  out = JSON.parse(redo2.stdout);
  assert.equal(out.redo, 'solve');
  assert.equal(out.edges, edgesAfterSolve);

  const replayed = JSON.parse(readFileSync(state, 'utf8'));
  assert.deepEqual(replayed.state, solved.state, 'redo must reproduce the solved state');
  assert.equal(replayed.state.derived.lastResult.status, 'feasible');

  const undo3 = runCli(['undo', '--state', state]);
  assert.equal(undo3.code, 0);
  const undo4 = runCli(['undo', '--state', state]);
  assert.equal(undo4.code, 0);
  const undo5 = runCli(['undo', '--state', state]);
  t.diagnostic(`undo exhausted: exit=${undo5.code} stderr=${undo5.stderr}`);
  assert.equal(undo5.code, 2, 'nothing-to-undo is a usage error');
});
