'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBank } = require('../src/biobank');

// One rack slot, project quota 1: only one sample of project A can be placed.
// agingWeight 10 means one priority level is worth 10 time units of waiting.
const CONFIG = {
  racks: [{ id: 'r1', zone: '-80', capacity: 1 }],
  quotas: { A: 1 },
  agingWeight: 10,
  freezeDelay: 100000,
};

const arrive = (time, id, priority, deadline = 10000) => ({
  type: 'arrive',
  time,
  sample: { id, project: 'A', priority, deadline, zone: '-80' },
});

test('quota exhaustion: low priority waits, high priority cannot jump the queue forever', () => {
  const bank = createBank(CONFIG);

  // t=0: X takes the only slot (and the only quota of project A).
  let r = bank.applyStep([arrive(0, 'X', 5)]);
  assert.deepEqual(r.placed, [{ sample: 'X', rack: 'r1', slot: 0 }]);

  // t=1: low-priority L arrives; quota is exhausted so it must wait.
  r = bank.applyStep([arrive(1, 'L', 1)]);
  assert.equal(r.placed.length, 0);
  assert.deepEqual(r.waiting, ['L']);

  // Each round frees the slot and introduces a fresh high-priority sample
  // (deadline t+5, so losers expire before the next round). L's aging score
  // grows by 10 per round; a fresh priority-9 sample scores 90.
  let winner = 'X';
  const winners = [];
  for (let k = 1; k <= 9; k++) {
    const t = 10 * k;
    r = bank.applyStep([
      { type: 'cancel', time: t, sampleId: winner },
      arrive(t, `H${k}`, 9, t + 5),
    ]);
    assert.equal(r.placed.length, 1, `round ${k} places exactly one sample`);
    winner = r.placed[0].sample;
    winners.push(winner);
    // Quota is never violated: exactly one sample of project A is placed.
    assert.equal(bank.certState().placed.length, 1);
  }

  // Rounds 1..8: fresh high-priority samples win (L scores 19..89 < 90),
  // so high priority is served promptly and never starves.
  assert.deepEqual(winners.slice(0, 8), ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8']);

  // Round 9 (t=90): L's aging score reaches 99 > 90, so the long-waiting
  // low-priority sample finally wins: high-priority arrivals could not
  // jump the queue indefinitely.
  assert.equal(winners[8], 'L');
  assert.deepEqual(bank.certState().placed.map((p) => p.id), ['L']);
});

test('ties are broken by sample id ascending', () => {
  const bank = createBank({
    racks: [{ id: 'r1', zone: '-80', capacity: 1 }],
    defaultQuota: 10,
    agingWeight: 10,
    freezeDelay: 100,
  });
  // Same priority, same arrival time -> same score; 'b' must not beat 'a'.
  const r = bank.applyStep([
    { type: 'arrive', time: 0, sample: { id: 'b', project: 'P', priority: 5, deadline: 100, zone: '-80' } },
    { type: 'arrive', time: 0, sample: { id: 'a', project: 'P', priority: 5, deadline: 100, zone: '-80' } },
  ]);
  assert.deepEqual(r.placed, [{ sample: 'a', rack: 'r1', slot: 0 }]);
  assert.deepEqual(r.waiting, ['b']);
});
