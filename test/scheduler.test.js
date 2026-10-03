import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FairScheduler } from '../src/scheduler.js';

const ev = (tenant, n) => ({ tenant, data: `e${n}` });

test('aging bounds starvation of a low-priority tenant', () => {
  const events = [ev('low', 0)];
  for (let i = 1; i <= 200; i++) events.push(ev('vip', i));
  const scheduler = new FairScheduler({
    priorities: { vip: 50, low: 0 },
    agingRate: 1,
    capacity: 1024,
  });
  const { admitted } = scheduler.run(events);
  assert.equal(admitted.length, 201);
  const pos = admitted.findIndex((r) => r.event.tenant === 'low');
  // Bound: ceil((50 - 0) / 1) + 1 rounds of backlog before low wins.
  assert.ok(pos > 0, 'vip is served first');
  assert.ok(pos <= 52, `low-priority tenant served at position ${pos}, expected <= 52`);
});

test('without aging a flooded low-priority tenant starves', () => {
  const events = [ev('low', 0)];
  for (let i = 1; i <= 50; i++) events.push(ev('vip', i));
  const scheduler = new FairScheduler({ priorities: { vip: 50, low: 0 }, agingRate: 0, capacity: 1024 });
  const { admitted } = scheduler.run(events);
  assert.equal(admitted[50].event.tenant, 'low', 'low is served dead last without aging');
});

test('equal priorities interleave fairly', () => {
  const events = [];
  for (let i = 0; i < 20; i++) events.push(ev('a', i), ev('b', i));
  const scheduler = new FairScheduler({ agingRate: 1, capacity: 1024 });
  const { admitted } = scheduler.run(events);
  let a = 0;
  let b = 0;
  for (const rec of admitted.slice(0, 20)) {
    if (rec.event.tenant === 'a') a++;
    else b++;
    assert.ok(Math.abs(a - b) <= 1, `unfair interleaving: a=${a} b=${b}`);
  }
});

test('hard disk quota is never exceeded', () => {
  const sizeOf = () => 30;
  const events = Array.from({ length: 10 }, (_, i) => ev('t', i));
  const scheduler = new FairScheduler({
    quotas: { t: { diskBytes: 100 } },
    capacity: 1024,
    sizeOf,
  });
  const { admitted, violations } = scheduler.run(events);
  assert.equal(admitted.length, 3, '3*30=90 <= 100, 4*30=120 > 100');
  assert.equal(violations.length, 7);
  assert.ok(violations.every((v) => v.code === 'QUOTA'));
  assert.ok(scheduler._tenant('t').usedBytes <= 100);
});

test('rate quota is a hard token-bucket bound', () => {
  const events = Array.from({ length: 50 }, (_, i) => ev('t', i));
  const scheduler = new FairScheduler({ quotas: { t: { ratePerSec: 5 } }, capacity: 1024 });
  const { admitted } = scheduler.run(events);
  assert.equal(admitted.length, 50);
  for (let i = 0; i < admitted.length; i++) {
    // Token bucket (capacity 5, 5 tokens/s): event i cannot be dispatched
    // before (i+1-5)*200ms of virtual time.
    const earliest = Math.max(0, i + 1 - 5) * 200;
    assert.ok(
      admitted[i].timeMs >= earliest - 1e-9,
      `event ${i} dispatched at ${admitted[i].timeMs}ms, earliest ${earliest}ms`,
    );
  }
});

test('bounded buffer still drains all events', () => {
  const events = Array.from({ length: 100 }, (_, i) => ev('t', i));
  const scheduler = new FairScheduler({ capacity: 8 });
  const { admitted } = scheduler.run(events);
  assert.equal(admitted.length, 100);
});
