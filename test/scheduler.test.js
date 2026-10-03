import test from 'node:test';
import assert from 'node:assert/strict';
import { Fraction } from '../src/fraction.js';
import { Scheduler } from '../src/scheduler.js';

const F = Fraction.parse;

test('acceptance 1: enumerate all instances in [0,H) matches per-instance brute force', () => {
  const s = new Scheduler('5');
  s.addRule({ id: 'r1', phase: '1/2', period: '3/4', duration: '1' });
  s.addRule({ id: 'r2', phase: '0', period: '2', duration: '1/3' });

  const enumerated = s.enumerateInstances();

  const brute = [];
  for (const rule of s.state().rules) {
    for (let k = 0; k < 1000; k++) {
      const start = rule.phase.add(rule.period.mul(new Fraction(BigInt(k))));
      if (!start.lt(s.H)) break;
      assert.ok(!start.isNegative());
      brute.push({ ruleId: rule.id, k, start: start.toString(), end: start.add(rule.duration).toString() });
    }
  }
  brute.sort((a, b) => F(a.start).cmp(F(b.start)) || (a.ruleId < b.ruleId ? -1 : 1));

  assert.deepEqual(
    enumerated.map((i) => ({ ruleId: i.ruleId, k: i.k, start: i.start.toString(), end: i.end.toString() })),
    brute
  );
  // every instance starts inside [0,H)
  for (const i of enumerated) {
    assert.ok(i.start.ge(F(0)) && i.start.lt(s.H));
  }
  // boundary: instance starting exactly at H is excluded
  const s2 = new Scheduler('4');
  s2.addRule({ id: 'x', phase: '0', period: '2', duration: '1' });
  assert.deepEqual(s2.enumerateInstances().map((i) => i.start.toString()), ['0', '2']);
});

test('acceptance 2: [0,1) vs [1,2) no conflict, overlapping interior conflicts', () => {
  const s = new Scheduler('10');
  s.addRule({ id: 'r', phase: '1', period: '10', duration: '1' }); // instance [1,2)
  s.addReservation({ id: 'touching', start: '0', end: '1', priority: 1 });
  s.addReservation({ id: 'inside', start: '1/2', end: '3/2', priority: 1 });
  assert.equal(s.checkReservation('touching').status, 'none');
  assert.equal(s.checkReservation('inside').status, 'conflict');
  assert.deepEqual(
    s.checkReservation('inside').conflicts.map((c) => [c.start.toString(), c.end.toString()]),
    [['1', '2']]
  );

  // symmetric: instance [0,1) vs reservation [1,2) also no conflict
  const s2 = new Scheduler('10');
  s2.addRule({ id: 'r', phase: '0', period: '10', duration: '1' }); // instance [0,1)
  s2.addReservation({ id: 'after', start: '1', end: '2', priority: 1 });
  assert.equal(s2.checkReservation('after').status, 'none');
});

test('acceptance 3: jitter yields possible with boundary certificate', () => {
  const s = new Scheduler('5');
  // instance [1,2), jitter j in [-1/4, 1/4]
  s.addRule({ id: 'j', phase: '1', period: '10', duration: '1', jitter: ['-1/4', '1/4'] });
  // reservation [0, 4/5): conflict iff j < 4/5 - 1 = -1/5; partial overlap of jitter range
  s.addReservation({ id: 'edge', start: '0', end: '4/5', priority: 1 });
  // reservation [0,3): contains every jittered instance -> definite conflict
  s.addReservation({ id: 'wide', start: '0', end: '3', priority: 1 });
  // reservation [3,4): unreachable by any jitter -> none
  s.addReservation({ id: 'far', start: '3', end: '4', priority: 1 });

  const edge = s.checkReservation('edge');
  assert.equal(edge.status, 'possible');
  assert.equal(edge.possible.length, 1);
  const cert = edge.possible[0];
  assert.equal(cert.ruleId, 'j');
  assert.equal(cert.k, 0);
  // boundary certificate: conflict begins at j = e - a = -1/5, ends at j = s - a - d = -2
  assert.equal(cert.boundary.upper.toString(), '-1/5');
  assert.equal(cert.boundary.lower.toString(), '-2');
  // effective jitter sub-range that produces a conflict: [-1/4, -1/5)
  assert.deepEqual(cert.conflictJitterRange.map(String), ['-1/4', '-1/5']);

  assert.equal(s.checkReservation('wide').status, 'conflict');
  assert.equal(s.checkReservation('far').status, 'none');
});

test('acceptance 4: undo of override restores low-priority reservation', () => {
  const s = new Scheduler('10');
  s.addRule({ id: 'r', phase: '0', period: '10', duration: '2' });
  s.addReservation({ id: 'low', start: '0', end: '1', priority: 1 });
  s.addReservation({ id: 'high', start: '0', end: '1', priority: 9 });

  s.override('high', 'low', { permit: true });
  assert.deepEqual(s.state().overrides, [{ high: 'high', overridden: ['low'] }]);
  assert.equal(s.checkReservation('low').status, 'overridden');

  assert.equal(s.undo(), true);
  assert.equal(s.checkReservation('low').status, 'conflict');
  assert.deepEqual(s.state().overrides, []);

  assert.equal(s.redo(), true);
  assert.equal(s.checkReservation('low').status, 'overridden');
});

test('override records overridden id chain transitively', () => {
  const s = new Scheduler('10');
  s.addReservation({ id: 'a', start: '0', end: '1', priority: 1 });
  s.addReservation({ id: 'b', start: '0', end: '1', priority: 5 });
  s.addReservation({ id: 'c', start: '0', end: '1', priority: 9 });
  s.override('b', 'a', { permit: true });
  s.override('c', 'b', { permit: true });
  assert.deepEqual(s.state().overrides, [
    { high: 'b', overridden: ['a'] },
    { high: 'c', overridden: ['b', 'a'] },
  ]);
});

test('override requires permit and strictly higher priority', () => {
  const s = new Scheduler('10');
  s.addReservation({ id: 'low', start: '0', end: '1', priority: 1 });
  s.addReservation({ id: 'high', start: '0', end: '1', priority: 9 });
  assert.throws(() => s.override('high', 'low'), /permit/);
  assert.throws(() => s.override('high', 'low', { permit: false }), /permit/);
  assert.throws(() => s.override('low', 'high', { permit: true }), /priority/);
  // failed attempts rolled back: nothing overridden
  assert.equal(s.checkReservation('low').status, 'none');
  assert.deepEqual(s.state().overrides, []);
});

test('transaction rollback: period<=0, end<=start, zero denominator', () => {
  const s = new Scheduler('10');
  s.addRule({ id: 'r', phase: '0', period: '2', duration: '1' });

  assert.throws(() => s.addRule({ id: 'bad', phase: '0', period: '0', duration: '1' }), /period must be > 0/);
  assert.throws(() => s.addRule({ id: 'bad2', phase: '0', period: '-1/2', duration: '1' }), /period must be > 0/);
  assert.throws(() => s.addRule({ id: 'bad3', phase: '0', period: '1/0', duration: '1' }), /denominator is zero/);
  assert.throws(() => s.updateRule('r', { period: '0' }), /period must be > 0/);
  assert.throws(() => s.addReservation({ id: 'z', start: '1', end: '1' }), /end must be > start/);
  assert.throws(() => s.addReservation({ id: 'z2', start: '2', end: '1' }), /end must be > start/);

  // state untouched by failed transactions
  assert.deepEqual(s.state().rules.map((r) => r.id), ['r']);
  assert.equal(s.state().rules[0].period.toString(), '2');
  assert.deepEqual(s.state().reservations, []);
});

test('undo/redo across rule commits', () => {
  const s = new Scheduler('10');
  s.addRule({ id: 'r', phase: '0', period: '2', duration: '1' });
  s.updateRule('r', { period: '3' });
  assert.equal(s.state().rules[0].period.toString(), '3');
  s.undo();
  assert.equal(s.state().rules[0].period.toString(), '2');
  s.undo();
  assert.deepEqual(s.state().rules, []);
  assert.equal(s.undo(), false);
  s.redo();
  s.redo();
  assert.equal(s.state().rules[0].period.toString(), '3');
  assert.equal(s.redo(), false);
});
