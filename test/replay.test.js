import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/scheduler.js';
import { join, claim } from './helpers.js';

// 验收 1: 三车并发抢单,终态确定。
test('three concurrent claims: deterministic contested-pending final state', () => {
  const events = [
    join('agv-a'), join('agv-b'), join('agv-c'),
    { type: 'task', task: 't1', time: 1 },
    claim('t1', 'agv-a', 1, 10, 1000, { 'agv-a': 1 }),
    claim('t1', 'agv-b', 1, 11, 1000, { 'agv-b': 1 }),
    claim('t1', 'agv-c', 1, 12, 1000, { 'agv-c': 1 }),
  ];
  const first = replay(events);
  const second = replay(events);
  assert.deepEqual(first.snapshot(), second.snapshot(), 'replay must be deterministic');

  const t = first.tasks.get('t1');
  assert.equal(t.status, 'pending', 'incomparable claims keep the task pending, not failed');
  assert.equal(t.owner, null);
  assert.equal(t.contested, true);
  assert.equal(first.snapshot().summary.contested, 1);

  const results = first.decisions.filter((d) => d.event === 'claim').map((d) => d.result);
  assert.deepEqual(results, ['granted', 'contested', 'contested']);
});

test('causally ordered claims: earliest claimer wins, later claims held', () => {
  const events = [
    join('agv-a'), join('agv-b'), join('agv-c'),
    claim('t1', 'agv-a', 1, 10, 1000, { s: 1 }),
    claim('t1', 'agv-b', 1, 11, 1000, { s: 2 }),
    claim('t1', 'agv-c', 1, 12, 1000, { s: 3 }),
  ];
  const s = replay(events);
  const t = s.tasks.get('t1');
  assert.equal(t.status, 'claimed');
  assert.equal(t.owner, 'agv-a');
  const results = s.decisions.filter((d) => d.event === 'claim').map((d) => d.result);
  assert.deepEqual(results, ['granted', 'rejected', 'rejected']);
  const reasons = s.decisions.filter((d) => d.event === 'claim').map((d) => d.reason ?? null);
  assert.deepEqual(reasons, [null, 'held', 'held']);
});

test('contested task resolves when a claim causally follows all contenders', () => {
  const events = [
    join('agv-a'), join('agv-b'), join('agv-c'),
    claim('t1', 'agv-a', 1, 10, 1000, { 'agv-a': 1 }),
    claim('t1', 'agv-b', 1, 11, 1000, { 'agv-b': 1 }),
    claim('t1', 'agv-c', 2, 12, 1000, { 'agv-a': 1, 'agv-b': 1, 'agv-c': 1 }),
  ];
  const s = replay(events);
  const t = s.tasks.get('t1');
  assert.equal(t.status, 'claimed');
  assert.equal(t.owner, 'agv-c');
  assert.equal(t.fencingEpoch, 2);
});

test('leave moves unfinished moves to the takeover set; quarantine keeps history', () => {
  const events = [
    join('agv-a'), join('agv-b'),
    claim('t1', 'agv-a', 1, 0, 1000, { s: 1 }),
    claim('t2', 'agv-b', 1, 0, 1000, { s: 2 }),
    { type: 'leave', agv: 'agv-a', time: 5 },
    { type: 'quarantine', agv: 'agv-b', time: 6 },
  ];
  const s = replay(events);
  const t1 = s.tasks.get('t1');
  assert.equal(t1.status, 'pending');
  assert.equal(t1.takeoverEligible, true);
  assert.deepEqual(s.snapshot().summary.takeoverSet, ['t1']);
  // quarantine: lease untouched, history preserved
  const t2 = s.tasks.get('t2');
  assert.equal(t2.status, 'claimed');
  assert.equal(t2.owner, 'agv-b');
  assert.equal(t2.history.some((h) => h.agv === 'agv-b' && h.result === 'granted'), true);
});

test('complete only by owner within lease', () => {
  const s = replay([
    join('agv-a'), join('agv-b'),
    claim('t1', 'agv-a', 1, 0, 100, { s: 1 }),
    { type: 'complete', task: 't1', agv: 'agv-b', time: 10 },
    { type: 'complete', task: 't1', agv: 'agv-a', time: 200 },
    { type: 'complete', task: 't1', agv: 'agv-a', time: 50 },
  ]);
  const t = s.tasks.get('t1');
  assert.equal(t.status, 'completed');
  const results = s.decisions.filter((d) => d.event === 'complete').map((d) => d.result);
  assert.deepEqual(results, ['rejected', 'rejected', 'completed']);
});
