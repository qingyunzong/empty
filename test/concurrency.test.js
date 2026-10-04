import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, toJsonl } from '../support/helpers.mjs';

// Three shuttles, three single-move tasks. M1 and M2 both need aisle A1;
// M3 uses aisle A9 whose state is never recorded anywhere.
const CONFIG = {
  type: 'config', wave: 'W1', budget: 100,
  shuttles: [
    { id: 'S1', home: 'A1:0' },
    { id: 'S2', home: 'A1:0' },
    { id: 'S3', home: 'A9:0' },
  ],
};
const AISLE_UNKNOWN = { type: 'aisle', id: 'A9', state: 'unknown' };
const TASK1 = { type: 'task', id: 'T1', moves: [{ id: 'M1', from: 'A1:0', to: 'A1:4', energy: 4, duration: 4 }] };
const TASK2 = { type: 'task', id: 'T2', moves: [{ id: 'M2', from: 'A1:0', to: 'A1:2', energy: 2, duration: 2 }] };
const TASK3 = { type: 'task', id: 'T3', moves: [{ id: 'M3', from: 'A9:0', to: 'A9:1', energy: 1, duration: 1 }] };

function plan() {
  const r = runCli(['wave'], toJsonl([CONFIG, AISLE_UNKNOWN, TASK1, TASK2, TASK3]));
  assert.equal(r.code, 0);
  return r.lines;
}

test('acceptance 3: planned schedule never double-books an aisle', () => {
  const lines = plan();
  const moves = lines.filter((l) => l.type === 'move');
  const byAisle = new Map();
  for (const m of moves) {
    for (const aisle of m.aisles) {
      if (!byAisle.has(aisle)) byAisle.set(aisle, []);
      byAisle.get(aisle).push(m);
    }
  }
  for (const [aisle, list] of byAisle) {
    const sorted = list.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i].start >= sorted[i - 1].end,
        `aisle ${aisle}: ${sorted[i].id} overlaps ${sorted[i - 1].id}`);
    }
  }
  // The two A1 moves are causally serialized.
  const a1 = byAisle.get('A1').slice().sort((a, b) => a.start - b.start);
  assert.equal(a1.length, 2);
  assert.ok(a1[1].start >= a1[0].end);
});

test('acceptance 3: only causally provable moves are released; conflicts stay pending', () => {
  const lines = plan();
  const moves = lines.filter((l) => l.type === 'move');
  const m1 = moves.find((m) => m.id === 'M1');
  const m2 = moves.find((m) => m.id === 'M2');

  // M1 starts executing and has no recorded completion: it occupies A1.
  const journal = [...lines, { type: 'execute', move: 'M1', start: m1.start }];
  const verify = runCli(['verify'], toJsonl(journal));
  assert.equal(verify.code, 0, JSON.stringify(verify.lines.find((l) => l.type === 'summary')));

  const relM2 = verify.lines.find((l) => l.type === 'release' && l.move === 'M2');
  assert.equal(relM2.status, 'pending');
  const aisleBlock = relM2.blockedBy.find((b) => b.reason === 'aisle-occupied');
  assert.ok(aisleBlock, 'M2 must be blocked by the A1 occupant');
  assert.equal(aisleBlock.move, 'M1');
  assert.equal(aisleBlock.aisle, 'A1');
  assert.equal(aisleBlock.condition, 'complete');

  // Unknown aisle state must not block: A9 has no recorded state or
  // occupant, yet M3 is released.
  const relM3 = verify.lines.find((l) => l.type === 'release' && l.move === 'M3');
  assert.equal(relM3.status, 'released');

  // Once M1 completes, the unblock condition lifts and M2 is released.
  const journal2 = [...lines, { type: 'execute', move: 'M1', start: m1.start, end: m1.end }];
  const verify2 = runCli(['verify'], toJsonl(journal2));
  assert.equal(verify2.code, 0);
  const rel2 = verify2.lines.find((l) => l.type === 'release' && l.move === 'M2');
  assert.equal(rel2.status, 'released');
  assert.ok(m2.start >= m1.end, 'planned M2 starts only after M1 frees A1');
});

test('acceptance 3: overlapping execution on one aisle is rejected by verify', () => {
  const lines = plan();
  // Forge an execution trace where M2 runs while M1 is still in flight.
  const journal = [
    ...lines,
    { type: 'execute', move: 'M1', start: 0 },
    { type: 'execute', move: 'M2', start: 1, end: 3 },
  ];
  const verify = runCli(['verify'], toJsonl(journal));
  assert.equal(verify.code, 1);
  const check = verify.lines.find((l) => l.type === 'check' && l.name === 'aisle-exclusion');
  assert.equal(check.ok, false);
  assert.ok(check.violations.some((v) => v.aisle === 'A1'));
});

test('unknown aisle state never produces a pending move', () => {
  // A wave whose only move uses an aisle with explicitly unknown state must
  // plan and release normally.
  const input = toJsonl([
    { type: 'config', wave: 'W1', budget: 10, shuttles: [{ id: 'S1', home: 'A7:0' }] },
    { type: 'aisle', id: 'A7', state: 'unknown' },
    { type: 'task', id: 'T1', moves: [{ id: 'MX', from: 'A7:0', to: 'A7:2', energy: 2, duration: 2 }] },
  ]);
  const wave = runCli(['wave'], input);
  assert.equal(wave.code, 0);
  const verify = runCli(['verify'], toJsonl(wave.lines));
  assert.equal(verify.code, 0);
  const rel = verify.lines.find((l) => l.type === 'release' && l.move === 'MX');
  assert.equal(rel.status, 'released');
});
