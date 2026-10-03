import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli, writeJson } from './helpers.js';

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'trace-cli-'));
  const state = join(cwd, 'state.json');
  return { cwd, state };
}

const feasibleInput = {
  materials: [
    { id: 'M1', quantity: 8, expiry: '2026-12-01' },
    { id: 'M2', quantity: 8, expiry: '2026-12-01' },
  ],
  batches: [
    {
      id: 'P1',
      line: 'L1',
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-01T04:00:00Z',
      output: 10,
      loss: 2,
      expiry: '2026-06-01',
      candidates: ['M1', 'M2'],
    },
  ],
};

test('trace prints a feasible assignment and exits 0', () => {
  const { cwd, state } = fixture();
  const input = writeJson(cwd, 'input.json', feasibleInput);
  const run = runCli(['trace', input, '--state', state]);
  assert.equal(run.code, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.status, 'feasible');
  assert.equal(Object.values(out.assignment.P1).reduce((a, b) => a + b, 0), 12);
});

test('infeasible input exits 1 with a conflict proof', () => {
  const { cwd, state } = fixture();
  const input = writeJson(cwd, 'input.json', {
    materials: [{ id: 'M0', quantity: 100, expiry: '2026-12-01', status: 'quarantined' }],
    batches: [
      {
        id: 'P0',
        line: 'L1',
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-01T02:00:00Z',
        output: 10,
        loss: 0,
        expiry: '2026-06-01',
        candidates: ['M0'],
      },
    ],
  });
  const run = runCli(['trace', input, '--state', state]);
  assert.equal(run.code, 1, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.status, 'infeasible');
  assert.deepEqual(out.conflict.chain.map((c) => c.batch), ['M0', 'P0']);
});

test('budget exhaustion exits 3 and lists pending choices', () => {
  const { cwd, state } = fixture();
  const input = writeJson(cwd, 'input.json', {
    materials: [
      { id: 'M1', quantity: 10, expiry: '2026-12-01' },
      { id: 'M2', quantity: 10, expiry: '2026-12-01' },
      { id: 'M3', quantity: 10, expiry: '2026-12-01' },
    ],
    batches: [
      {
        id: 'P1',
        line: 'L1',
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-01T04:00:00Z',
        output: 25,
        loss: 0,
        expiry: '2026-06-01',
        candidates: ['M1', 'M2', 'M3'],
      },
      {
        id: 'P2',
        line: 'L2',
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-01T04:00:00Z',
        output: 6,
        loss: 0,
        expiry: '2026-06-01',
        candidates: ['M1', 'M2', 'M3'],
      },
    ],
  });
  const run = runCli(['trace', input, '--state', state, '--budget', '1']);
  assert.equal(run.code, 3, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.status, 'unknown');
  assert.equal(out.reason, 'budget-exhausted');
  const p1 = out.pending.find((p) => p.batch === 'P1');
  const p2 = out.pending.find((p) => p.batch === 'P2');
  assert.equal(p1.required, 25);
  assert.equal(p2.required, 6);
  assert.deepEqual(
    p1.choices.map((c) => c.parent),
    ['M1', 'M2', 'M3'],
  );
});

test('illegal quantities and broken references exit 2', () => {
  const { cwd, state } = fixture();
  const badQuantity = writeJson(cwd, 'bad-qty.json', {
    materials: [{ id: 'M1', quantity: -5, expiry: '2026-12-01' }],
    batches: [],
  });
  const brokenRef = writeJson(cwd, 'broken-ref.json', {
    materials: [],
    batches: [
      {
        id: 'P1',
        line: 'L1',
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-01T04:00:00Z',
        output: 10,
        loss: 0,
        expiry: '2026-06-01',
        candidates: ['M404'],
      },
    ],
  });
  for (const path of [badQuantity, brokenRef]) {
    const run = runCli(['trace', path, '--state', state]);
    assert.equal(run.code, 2, `${path}: ${run.stdout}`);
    assert.equal(JSON.parse(run.stdout).status, 'invalid');
  }
});

test('undo restores the pre-add state and redo reproduces the result', () => {
  const { cwd, state } = fixture();
  const first = writeJson(cwd, 'first.json', feasibleInput);
  const second = writeJson(cwd, 'second.json', {
    materials: [],
    batches: [
      {
        id: 'P2',
        line: 'L2',
        start: '2026-01-01T06:00:00Z',
        end: '2026-01-01T08:00:00Z',
        output: 5,
        loss: 0,
        expiry: '2026-06-01',
        candidates: ['P1'],
      },
    ],
  });
  const run1 = runCli(['trace', first, '--state', state]);
  const run2 = runCli(['trace', second, '--state', state]);
  assert.equal(run1.code, 0);
  assert.equal(run2.code, 0);

  const undo = runCli(['undo', '--state', state]);
  assert.equal(undo.code, 0, undo.stderr);
  const undoOut = JSON.parse(undo.stdout);
  assert.equal(undoOut.status, 'undone');
  assert.equal(undoOut.depth, 1);
  assert.deepEqual(undoOut.result, JSON.parse(run1.stdout));

  const redo = runCli(['redo', '--state', state]);
  assert.equal(redo.code, 0, redo.stderr);
  const redoOut = JSON.parse(redo.stdout);
  assert.equal(redoOut.status, 'redone');
  assert.deepEqual(redoOut.result, JSON.parse(run2.stdout));
});

test('undo and redo on an empty history are graceful no-ops', () => {
  const { cwd, state } = fixture();
  const undo = runCli(['undo', '--state', state]);
  assert.equal(undo.code, 0);
  assert.equal(JSON.parse(undo.stdout).status, 'nothing-to-undo');
  const redo = runCli(['redo', '--state', state]);
  assert.equal(redo.code, 0);
  assert.equal(JSON.parse(redo.stdout).status, 'nothing-to-redo');
});
