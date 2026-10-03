import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, merge, clocksEqual, happensBefore } from '../src/clock.js';

test('compare: equal, before, after, concurrent', () => {
  assert.equal(compare({ A: 1 }, { A: 1 }), 'equal');
  assert.equal(compare({ A: 1 }, { A: 2 }), 'before');
  assert.equal(compare({ A: 2 }, { A: 1 }), 'after');
  assert.equal(compare({ A: 1 }, { B: 1 }), 'concurrent');
  assert.equal(compare({ A: 1, B: 1 }, { A: 1, B: 2 }), 'before');
  assert.equal(compare({ A: 2, B: 1 }, { A: 1, B: 2 }), 'concurrent');
  assert.equal(compare({}, {}), 'equal');
  assert.equal(compare({}, { A: 1 }), 'before');
});

test('merge takes element-wise max', () => {
  assert.deepEqual(merge({ A: 1, B: 2 }, { B: 1, C: 5 }), { A: 1, B: 2, C: 5 });
});

test('clocksEqual / happensBefore', () => {
  assert.ok(clocksEqual({ A: 1 }, { A: 1 }));
  assert.ok(!clocksEqual({ A: 1 }, { A: 2 }));
  assert.ok(happensBefore({ A: 1 }, { A: 1, B: 1 }));
  assert.ok(!happensBefore({ A: 1 }, { B: 1 }));
});
