'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBank, ERR } = require('../src/biobank');

const CONFIG = {
  racks: [{ id: 'r1', zone: '-80', capacity: 2 }],
  defaultQuota: 10,
  agingWeight: 10,
  freezeDelay: 5,
};

const arriveA = { type: 'arrive', time: 0, sample: { id: 'A', project: 'p', priority: 1, deadline: 100, zone: '-80' } };
const arriveB = { type: 'arrive', time: 0, sample: { id: 'B', project: 'q', priority: 2, deadline: 100, zone: '-80' } };
const arriveC = { type: 'arrive', time: 1, sample: { id: 'C', project: 'r', priority: 9, deadline: 100, zone: '-80' } };

test('preemption withdraws only unfrozen samples and undo restores them', () => {
  const bank = createBank(CONFIG);
  const hashes = [bank.hash()];

  const r1 = bank.applyStep([arriveA, arriveB]);
  assert.deepEqual(r1.placed, [
    { sample: 'B', rack: 'r1', slot: 0 },
    { sample: 'A', rack: 'r1', slot: 1 },
  ]);
  hashes.push(bank.hash());

  // Rack is full; C (priority 9) preempts the lowest-scored unfrozen sample (A).
  const r2 = bank.applyStep([arriveC]);
  assert.deepEqual(r2.preempted, [{ sample: 'A', rack: 'r1', slot: 1, by: 'C' }]);
  assert.deepEqual(r2.placed, [{ sample: 'C', rack: 'r1', slot: 1 }]);
  assert.deepEqual(r2.waiting, ['A']);
  hashes.push(bank.hash());

  // Undo to event point 2: the preemption is reversed, A is back in its slot.
  const r3 = bank.applyStep([{ type: 'undo', time: 2, to: 2 }]);
  assert.equal(r3.hash, hashes[1], 'hash after undo equals the hash recorded at event point 2');
  assert.deepEqual(
    bank.certState().placed.map((p) => `${p.id}@${p.slot}`).sort(),
    ['A@1', 'B@0']
  );
  assert.equal(bank.certState().waiting.length, 0);

  // Undo to event point 0: empty bank, same hash as at the start.
  const r4 = bank.applyStep([{ type: 'undo', time: 3, to: 0 }]);
  assert.equal(r4.hash, hashes[0]);
  assert.equal(bank.eventPoint, 0);

  // Hierarchical undo: replay events, then roll back to any intermediate point.
  bank.applyStep([arriveA, arriveB]);
  bank.applyStep([arriveC]);
  const rMid = bank.applyStep([{ type: 'undo', time: 4, to: 1 }]);
  assert.deepEqual(bank.certState().placed.map((p) => p.id), ['A'], 'only the first event remains');
  assert.equal(rMid.eventPoint, 1);
  // Undo to a mid-batch event point equals replaying exactly that prefix.
  const solo = createBank(CONFIG);
  assert.equal(rMid.hash, solo.applyStep([arriveA]).hash, 'undo replay is consistent');
  // Roll back further, then re-apply the original sequence: hashes reproduce.
  const rBack = bank.applyStep([{ type: 'undo', time: 5, to: 0 }]);
  assert.equal(rBack.hash, hashes[0]);
  bank.applyStep([arriveA, arriveB]);
  assert.equal(bank.hash(), hashes[1]);
  bank.applyStep([arriveC]);
  assert.equal(bank.hash(), hashes[2], 're-applying events reproduces the original hash');
});

test('replay after undo is deterministic and reproduces the original hashes', () => {
  const run = () => {
    const bank = createBank(CONFIG);
    const out = [];
    out.push(bank.applyStep([arriveA, arriveB]).hash);
    out.push(bank.applyStep([arriveC]).hash);
    out.push(bank.applyStep([{ type: 'undo', time: 2, to: 2 }]).hash);
    out.push(bank.applyStep([arriveC]).hash);
    return out;
  };
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
  // After undoing C's arrival and replaying it, the state hash is identical
  // to the first time C arrived (same logical time and events).
  assert.equal(first[3], first[1]);
});

test('frozen samples cannot be preempted or cancelled', () => {
  const bank = createBank(CONFIG);
  bank.applyStep([arriveA, arriveB]); // placed at t=0, freezeDelay 5
  const r = bank.applyStep([{ type: 'arrive', time: 10, sample: { id: 'C', project: 'r', priority: 9, deadline: 100, zone: '-80' } }]);
  assert.deepEqual(r.preempted, [], 'no preemption: all placed samples are frozen at t=10');
  assert.deepEqual(r.placed, []);
  assert.deepEqual(r.waiting, ['C']);

  const before = bank.hash();
  assert.throws(
    () => bank.applyStep([{ type: 'cancel', time: 11, sampleId: 'A' }]),
    (err) => err.code === ERR.INVALID_EVENT && /frozen/.test(err.message)
  );
  assert.equal(bank.hash(), before, 'failed cancel leaves state unchanged');
});

test('preemption is a no-op when the preemptor cannot use the freed slot', () => {
  const bank = createBank({
    racks: [{ id: 'r1', zone: '-80', capacity: 1 }],
    quotas: { r: 0 },
    defaultQuota: 10,
    agingWeight: 10,
    freezeDelay: 100,
  });
  bank.applyStep([{ type: 'arrive', time: 0, sample: { id: 'A', project: 'p', priority: 1, deadline: 100, zone: '-80' } }]);
  // Project r has quota 0: even freeing the slot would not let C in.
  const r = bank.applyStep([{ type: 'arrive', time: 1, sample: { id: 'C', project: 'r', priority: 9, deadline: 100, zone: '-80' } }]);
  assert.deepEqual(r.preempted, []);
  assert.deepEqual(r.placed, []);
  assert.deepEqual(bank.certState().placed.map((p) => p.id), ['A']);
});
