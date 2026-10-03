import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/store.js';

function makeDir(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-'));
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input, null, 2));
  return dir;
}

const input = {
  capacity: 10,
  agingLimit: 1,
  agingBonus: 1,
  institutions: { A: { quota: 10 }, B: { quota: 10 } },
  batches: [
    { id: 'a1', institution: 'A', amount: 6, priority: 5 },
    { id: 'b1', institution: 'B', amount: 8, priority: 3, splittable: true },
    { id: 'g1a', institution: 'A', amount: 4, priority: 2, group: 'g1' },
    { id: 'g1b', institution: 'B', amount: 2, priority: 2, group: 'g1' },
  ],
};

function crashPartialRound(dir, index) {
  // emulate the fault point: round dir + round.json written, no commit.marker
  const rd = path.join(dir, 'rounds', store.roundName(index));
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(
    path.join(rd, 'round.json'),
    JSON.stringify({ index, allocations: [{ batch: 'b1', group: null, institution: 'B', amount: 8 }], used: 8, proof: 'deadbeef' }),
  );
}

test('commit then recover with no crash keeps all rounds visible', () => {
  const dir = makeDir(input);
  const r1 = store.commitNext(dir);
  const r2 = store.commitNext(dir);
  assert.equal(r1.round.index, 1);
  assert.equal(r2.round.index, 2);
  const { rolledBack, committed, state } = store.recover(dir);
  assert.deepEqual(rolledBack, []);
  assert.equal(committed, 2);
  assert.equal(state.nextRound, 3);
  assert.equal(state.proof, r2.state.proof);
  const v = store.verify(dir);
  assert.ok(v.ok, JSON.stringify(v.errors));
});

test('crash after round dir but before commit.marker rolls back the whole round', () => {
  const dir = makeDir(input);
  const r1 = store.commitNext(dir);
  crashPartialRound(dir, 2);
  const { rolledBack, committed, state } = store.recover(dir);
  assert.deepEqual(rolledBack, ['round-000002']);
  assert.equal(committed, 1);
  assert.equal(state.nextRound, 2);
  assert.equal(state.proof, r1.state.proof, 'state rolled back to round 1');
  assert.ok(!fs.existsSync(path.join(dir, 'rounds', 'round-000002')), 'partial dir removed');
  // the rolled-back round can be re-planned and committed cleanly
  const r2 = store.commitNext(dir);
  assert.equal(r2.round.index, 2);
  const v = store.verify(dir);
  assert.ok(v.ok, JSON.stringify(v.errors));
});

test('commit.marker present means the round survives even if state.json is lost', () => {
  const dir = makeDir(input);
  store.commitNext(dir);
  const r2 = store.commitNext(dir);
  fs.rmSync(path.join(dir, 'state.json'));
  const { rolledBack, state } = store.recover(dir);
  assert.deepEqual(rolledBack, []);
  assert.equal(state.proof, r2.state.proof, 'state rebuilt from committed rounds');
  assert.deepEqual(state.remaining, r2.state.remaining);
});

test('full drain: commits settle every batch, verify passes at each step', () => {
  const dir = makeDir(input);
  let r;
  let n = 0;
  do {
    r = store.commitNext(dir);
    if (r) {
      n++;
      const v = store.verify(dir);
      assert.ok(v.ok, JSON.stringify(v.errors));
    }
  } while (r);
  assert.ok(n >= 2);
  const state = store.loadState(dir);
  assert.equal(Object.keys(state.remaining).length, 0);
});

test('verify detects tampering with a committed round', () => {
  const dir = makeDir(input);
  store.commitNext(dir);
  const file = path.join(dir, 'rounds', 'round-000001', 'round.json');
  const round = JSON.parse(fs.readFileSync(file, 'utf8'));
  round.allocations[0].amount += 1;
  fs.writeFileSync(file, JSON.stringify(round, null, 2));
  const v = store.verify(dir);
  assert.ok(!v.ok);
  assert.equal(v.errors[0].code, 'PARTIAL_COMMIT');
});

test('verify reports PARTIAL_COMMIT for a round dir without marker', () => {
  const dir = makeDir(input);
  store.commitNext(dir);
  crashPartialRound(dir, 2);
  const v = store.verify(dir);
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => e.code === 'PARTIAL_COMMIT'));
});
