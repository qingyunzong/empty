import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, verifyCertificate, effectivePriority, ERR } from '../src/engine.js';

const run = (config, events) => createEngine(config).run(events);
const types = (r) => r.timeline.map((t) => `${t.slot}:${t.type}:${t.id ?? ''}`);
const codes = (r) => r.violations.map((v) => v.code);

test('boundary: capture at expiry slot fails, one slot earlier succeeds', () => {
  const r = run({ pool: 1000 }, [
    { type: 'auth', id: 'a', card: 'c', amount: 50, priority: 0, slot: 0, expires: 5 },
    { type: 'capture', id: 'a', slot: 5 },
  ]);
  assert.deepEqual(types(r), ['0:auth:a', '5:expire:a']);
  assert.deepEqual(codes(r), [ERR.AUTH_EXPIRED]);

  const r2 = run({ pool: 1000 }, [
    { type: 'auth', id: 'a', card: 'c', amount: 50, priority: 0, slot: 0, expires: 5 },
    { type: 'capture', id: 'a', slot: 4 },
  ]);
  assert.deepEqual(types(r2), ['0:auth:a', '4:capture:a']);
  assert.deepEqual(r2.violations, []);
});

test('boundary: same-slot expiry and capture of different auths, expiry frees pool first', () => {
  // a expires at slot 3; b (queued) must be woken by that expiry before the
  // slot-3 capture of c is processed.
  const r = run({ pool: 100 }, [
    { type: 'auth', id: 'a', card: 'c', amount: 60, priority: 0, slot: 0, expires: 3 },
    { type: 'auth', id: 'c', card: 'c', amount: 40, priority: 0, slot: 0, expires: 10 },
    { type: 'auth', id: 'b', card: 'c', amount: 60, priority: 0, slot: 1, expires: 10 },
    { type: 'capture', id: 'c', slot: 3 },
  ]);
  assert.deepEqual(types(r), [
    '0:auth:a', '0:auth:c', '1:queue:b',
    '3:expire:a', '3:auth:b', '3:wake:', '3:capture:c',
  ]);
  assert.deepEqual(r.violations.map((v) => v.code), [ERR.POOL_SHORT, ERR.PREEMPT_FORBID]);
});

test('preemption: high priority preempts soon-expiring low priority', () => {
  const r = run({ pool: 100, preemptWindow: 2 }, [
    { type: 'auth', id: 'low', card: 'c', amount: 60, priority: 0, slot: 0, expires: 3 },
    { type: 'auth', id: 'vip', card: 'c', amount: 100, priority: 5, slot: 1, expires: 9 },
  ]);
  assert.deepEqual(types(r), ['0:auth:low', '1:preempt:low', '1:auth:vip']);
  assert.deepEqual(r.violations, []);
});

test('preemption forbidden: same priority earlier-expiring auth is untouchable', () => {
  const r = run({ pool: 100, preemptWindow: 2 }, [
    { type: 'auth', id: 'm', card: 'c', amount: 60, priority: 5, slot: 0, expires: 3 },
    { type: 'auth', id: 'h', card: 'c', amount: 100, priority: 5, slot: 1, expires: 9 },
  ]);
  assert.deepEqual(types(r), ['0:auth:m', '1:queue:h']);
  assert.deepEqual(codes(r), [ERR.POOL_SHORT, ERR.PREEMPT_FORBID]);
  // m is still active and expires normally at slot 3
  const r2 = run({ pool: 100, preemptWindow: 2 }, [
    { type: 'auth', id: 'm', card: 'c', amount: 60, priority: 5, slot: 0, expires: 3 },
    { type: 'auth', id: 'h', card: 'c', amount: 100, priority: 5, slot: 1, expires: 9 },
    { type: 'capture', id: 'm', slot: 2 },
  ]);
  // capturing m frees the pool, so the queued h is woken right after
  assert.deepEqual(types(r2), ['0:auth:m', '1:queue:h', '2:capture:m', '2:auth:h', '2:wake:']);
});

test('preemption rollback: insufficient victims leaves state untouched', () => {
  // shortfall is 60 but the two preemptible victims only cover 50, so the
  // preemption plan must be rolled back atomically.
  const r = run({ pool: 100, preemptWindow: 2 }, [
    { type: 'auth', id: 'l1', card: 'c', amount: 30, priority: 0, slot: 0, expires: 3 },
    { type: 'auth', id: 'l2', card: 'c', amount: 20, priority: 0, slot: 0, expires: 3 },
    { type: 'auth', id: 'h', card: 'c', amount: 110, priority: 5, slot: 1, expires: 9 },
    { type: 'capture', id: 'l1', slot: 2 },
    { type: 'capture', id: 'l2', slot: 2 },
  ]);
  // no preempt entries; both victims still capturable afterwards
  assert.deepEqual(types(r), [
    '0:auth:l1', '0:auth:l2', '1:queue:h', '2:capture:l1', '2:capture:l2',
  ]);
  assert.deepEqual(codes(r), [ERR.POOL_SHORT]);
});

test('captured auth cannot be preempted and double capture reports CAPTURED', () => {
  // a is captured (settled) at slot 1; when h needs room at slot 3 only the
  // still-active b is a preemption candidate, never the captured a.
  const r = run({ pool: 100, preemptWindow: 9 }, [
    { type: 'auth', id: 'a', card: 'c', amount: 80, priority: 0, slot: 0, expires: 9 },
    { type: 'capture', id: 'a', slot: 1 },
    { type: 'capture', id: 'a', slot: 2 },
    { type: 'auth', id: 'b', card: 'c', amount: 90, priority: 0, slot: 2, expires: 9 },
    { type: 'auth', id: 'h', card: 'c', amount: 100, priority: 5, slot: 3, expires: 9 },
  ]);
  assert.deepEqual(types(r), [
    '0:auth:a', '1:capture:a', '2:auth:b', '3:preempt:b', '3:auth:h',
  ]);
  assert.deepEqual(codes(r), [ERR.CAPTURED]);
  assert.ok(!r.timeline.some((t) => t.type === 'preempt' && t.id === 'a'));
});

test('partial capture releases the remainder back to the pool', () => {
  const r = run({ pool: 100 }, [
    { type: 'auth', id: 'a', card: 'c', amount: 100, priority: 0, slot: 0, expires: 9 },
    { type: 'auth', id: 'b', card: 'c', amount: 40, priority: 0, slot: 1, expires: 9 },
    { type: 'capture', id: 'a', slot: 2, amount: 60 },
  ]);
  assert.deepEqual(types(r), ['0:auth:a', '1:queue:b', '2:capture:a', '2:auth:b', '2:wake:']);
  const cap = r.timeline.find((t) => t.type === 'capture');
  assert.equal(cap.released, 40);
});

test('revoke cascades wakeups and emits a wake proof', () => {
  const r = run({ pool: 100 }, [
    { type: 'auth', id: 'a', card: 'c', amount: 100, priority: 0, slot: 0, expires: 50 },
    { type: 'auth', id: 'b', card: 'c', amount: 60, priority: 0, slot: 1, expires: 50 },
    { type: 'auth', id: 'c', card: 'c', amount: 40, priority: 0, slot: 1, expires: 50 },
    { type: 'revoke', id: 'a', slot: 2 },
  ]);
  const wake = r.timeline.find((t) => t.type === 'wake');
  assert.deepEqual(wake.trigger, { type: 'revoke', id: 'a' });
  assert.deepEqual(wake.woke, ['b', 'c']);
  assert.deepEqual(wake.proof.woke, ['b', 'c']);
  assert.equal(wake.proof.poolFrozen, 100);
  assert.equal(wake.proof.poolLimit, 100);
  assert.equal(r.queue.length, 0);
});

test('card limit is a hard constraint: reject, never queue', () => {
  const r = run({ pool: 1000, cards: { c1: 50 } }, [
    { type: 'auth', id: 'a', card: 'c1', amount: 60, priority: 0, slot: 0, expires: 9 },
  ]);
  assert.deepEqual(types(r), ['0:reject:a']);
  assert.deepEqual(codes(r), [ERR.CARD_LIMIT]);
  assert.equal(r.queue.length, 0);
});

test('aging: +1 per k waited slots, capped at +2', () => {
  assert.equal(effectivePriority({ priority: 0, slot: 0 }, 0, 2), 0);
  assert.equal(effectivePriority({ priority: 0, slot: 0 }, 1, 2), 0);
  assert.equal(effectivePriority({ priority: 0, slot: 0 }, 2, 2), 1);
  assert.equal(effectivePriority({ priority: 0, slot: 0 }, 3, 2), 1);
  assert.equal(effectivePriority({ priority: 0, slot: 0 }, 4, 2), 2);
  assert.equal(effectivePriority({ priority: 0, slot: 0 }, 100, 2), 2);
});

test('starvation bound: aged low-priority request beats newer higher base priority within 2k slots', () => {
  // b (prio 0) queued at slot 0; c (prio 1) queued at slot 3. With k=2, at
  // slot 4 b has effective priority 2 > c's 1, so b is placed first when
  // funds free up. b waited exactly 4 = 2k slots.
  const r = run({ pool: 100, agingK: 2 }, [
    { type: 'auth', id: 'a', card: 'c', amount: 100, priority: 9, slot: 0, expires: 100 },
    { type: 'auth', id: 'b', card: 'c', amount: 100, priority: 0, slot: 0, expires: 100 },
    { type: 'auth', id: 'c', card: 'c', amount: 100, priority: 1, slot: 3, expires: 100 },
    { type: 'revoke', id: 'a', slot: 4 },
  ]);
  const wake = r.timeline.find((t) => t.type === 'wake');
  assert.deepEqual(wake.woke, ['b']);
  assert.deepEqual(r.queue.map((q) => q.id), ['c']);
  const waited = 4;
  assert.ok(waited <= 2 * 2, 'wait exceeds the 2k aging bound');
});

test('no starvation under sustained equal-priority arrivals', () => {
  // Pool fits one auth at a time. q queues at slot 0; every slot a new
  // equal-priority auth arrives and the previous one is captured. Aging
  // guarantees q is placed within 2k+1 slots.
  const events = [
    { type: 'auth', id: 'a0', card: 'c', amount: 100, priority: 1, slot: 0, expires: 100 },
    { type: 'auth', id: 'q', card: 'c', amount: 100, priority: 0, slot: 0, expires: 100 },
  ];
  for (let s = 1; s <= 6; s++) {
    events.push({ type: 'capture', id: `a${s - 1}`, slot: s });
    events.push({ type: 'auth', id: `a${s}`, card: 'c', amount: 100, priority: 1, slot: s, expires: 100 });
  }
  const r = run({ pool: 100, agingK: 2 }, events);
  const placed = r.timeline.find((t) => t.type === 'auth' && t.id === 'q');
  assert.ok(placed, 'q was never placed');
  assert.ok(placed.slot - 0 <= 2 * 2 + 1, `q waited ${placed.slot} slots, beyond bound`);
});

test('certificates verify and detect tampering', () => {
  const r = run({ pool: 100, cards: { c1: 80 } }, [
    { type: 'auth', id: 'a', card: 'c1', amount: 60, priority: 0, slot: 0, expires: 9 },
    { type: 'auth', id: 'b', card: 'c1', amount: 40, priority: 0, slot: 1, expires: 9 },
  ]);
  assert.equal(r.certificates.length, 2);
  for (const cert of r.certificates) {
    assert.equal(cert.ok, true);
    assert.deepEqual(verifyCertificate(cert), { ok: true, errors: [] });
  }
  const tampered = JSON.parse(JSON.stringify(r.certificates[1]));
  tampered.pool.frozen += 1;
  assert.equal(verifyCertificate(tampered).ok, false);
  const over = JSON.parse(JSON.stringify(r.certificates[1]));
  over.pool.limit = 1;
  assert.equal(verifyCertificate(over).ok, false);
});

test('determinism: identical outputs across runs and input permutations of same-slot events', () => {
  const events = [
    { type: 'auth', id: 'a', card: 'c', amount: 40, priority: 1, slot: 0, expires: 5 },
    { type: 'auth', id: 'b', card: 'c', amount: 40, priority: 1, slot: 0, expires: 5 },
    { type: 'auth', id: 'd', card: 'c', amount: 40, priority: 1, slot: 0, expires: 5 },
    { type: 'capture', id: 'a', slot: 2 },
    { type: 'revoke', id: 'b', slot: 2 },
  ];
  const r1 = run({ pool: 100 }, events);
  const r2 = run({ pool: 100 }, events);
  assert.deepEqual(r1, r2);
});
