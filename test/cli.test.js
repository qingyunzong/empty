import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli.js';

function run(state, ...args) {
  let stdout = '';
  let stderr = '';
  const code = main(['--state', state, ...args], {
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
  });
  return { code, stdout, stderr };
}

test('CLI end-to-end flow with persisted undo/redo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'));
  const state = join(dir, 'state.json');

  let r = run(state, 'create', 'R', '8');
  assert.equal(r.code, 0, r.stderr);
  r = run(state, 'split', 'R', 'A=1/2', 'B=1/2');
  assert.equal(r.code, 0, r.stderr);
  r = run(state, 'join', 'J', 'A,B', '0');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).quantity, '8');

  r = run(state, 'ratio', 'R', 'J');
  assert.equal(r.code, 0, r.stderr);
  const ratio = JSON.parse(r.stdout);
  assert.equal(ratio.paths.length, 2);
  assert.equal(ratio.total, '1');

  r = run(state, 'show', 'J', '--decimals', '3');
  const shown = JSON.parse(r.stdout);
  assert.equal(shown.value, '8.000');
  assert.equal(shown.exact, '8');
  assert.equal(shown.error, '0');
  assert.equal(shown.errorBound, '1/2000');

  r = run(state, 'quarantine', 'A');
  assert.equal(r.code, 0, r.stderr);
  r = run(state, 'contaminates', 'A', 'J');
  assert.equal(JSON.parse(r.stdout).contaminates, true);

  r = run(state, 'undo'); // undo quarantine
  assert.equal(r.code, 0, r.stderr);
  r = run(state, 'contaminates', 'A', 'J');
  assert.equal(JSON.parse(r.stdout).contaminates, false);
  r = run(state, 'redo');
  assert.equal(r.code, 0, r.stderr);
  r = run(state, 'contaminates', 'A', 'J');
  assert.equal(JSON.parse(r.stdout).contaminates, true);
});

test('CLI reports E_RATIONAL with exit code 1 and leaves state untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'));
  const state = join(dir, 'state.json');
  assert.equal(run(state, 'create', 'R', '10').code, 0);
  const r = run(state, 'split', 'R', 'A=1/2', 'B=1/3');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /E_RATIONAL/);
  const inv = JSON.parse(run(state, 'inventory').stdout);
  assert.deepEqual(inv, [{ id: 'R', quantity: '10', quarantined: false }]);
});

test('CLI exec runs ops in a single all-or-nothing transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'));
  const state = join(dir, 'state.json');
  assert.equal(run(state, 'create', 'R', '6').code, 0);
  const opsFile = join(dir, 'ops.json');
  writeFileSync(opsFile, JSON.stringify([
    { op: 'split', id: 'R', children: { A: '1/2', B: '1/2' } },
    { op: 'join', inputs: ['A', 'B'], output: 'J', loss: '1/3' },
    { op: 'quarantine', id: 'J' },
  ]));
  const r = run(state, 'exec', opsFile);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).committed, 3);
  const j = JSON.parse(run(state, 'show', 'J').stdout);
  assert.equal(j.exact, '4');
  assert.equal(j.quarantined, true);

  // Failing script: nothing is applied.
  writeFileSync(opsFile, JSON.stringify([
    { op: 'create', id: 'Q', quantity: '1' },
    { op: 'split', id: 'R', children: { X: '1/2', Y: '1/3' } },
  ]));
  const bad = run(state, 'exec', opsFile);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /E_RATIONAL/);
  const inv = JSON.parse(run(state, 'inventory').stdout);
  assert.ok(!inv.some((b) => b.id === 'Q' || b.id === 'X' || b.id === 'Y'));
});
