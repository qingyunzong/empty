import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { verifyCertificate } from '../src/core.js';

const CARDS = { gold: 1000, silver: 1000 };

function run(events, config = {}, strategy = 'heap') {
  const engine = new Engine({ pool: 100, agingK: 2, preemptWindow: 2, cards: CARDS, ...config }, { strategy });
  return engine.run(events);
}

const auth = (slot, id, amount, priority, expiry, card = 'gold') => ({
  slot, type: 'auth', id, card, amount, priority, expiry,
});
const capture = (slot, id, amount) => ({ slot, type: 'capture', id, ...(amount === undefined ? {} : { amount }) });
const revoke = (slot, id) => ({ slot, type: 'revoke', id });

const find = (timeline, pred) => timeline.find((t) => pred(t));
const results = (r, id) => r.timeline.filter((t) => t.id === id);

test('basic auth, capture, expiry lifecycle', () => {
  const r = run([
    auth(0, 'a', 40, 1, 5),
    auth(0, 'b', 30, 1, 2),
    capture(1, 'a', 25),
  ]);
  assert.deepEqual(find(r.timeline, (t) => t.id === 'a' && t.type === 'auth').result, 'admitted');
  assert.deepEqual(find(r.timeline, (t) => t.type === 'captured'), { slot: 1, type: 'captured', id: 'a', captureAmount: 25 });
  assert.deepEqual(find(r.timeline, (t) => t.type === 'expired'), { slot: 2, type: 'expired', id: 'b' });
  assert.equal(r.violations.length, 0);
  assert.ok(r.certificates.every(verifyCertificate));
});

test('boundary: capture at the exact expiry slot succeeds, one slot later fails', () => {
  const r = run([
    auth(0, 'x', 10, 1, 2),
    auth(0, 'y', 10, 1, 2),
    capture(2, 'x'),
    capture(3, 'y'),
  ]);
  assert.ok(find(r.timeline, (t) => t.id === 'x' && t.type === 'captured'));
  const yCapture = find(r.timeline, (t) => t.id === 'y' && t.type === 'capture');
  assert.equal(yCapture.result, 'rejected');
  assert.equal(yCapture.reason, 'AUTH_EXPIRED');
  assert.ok(r.violations.some((v) => v.id === 'y' && v.code === 'AUTH_EXPIRED'));
});

test('boundary: auth expiring at its submit slot lives until end of that slot', () => {
  const r = run([auth(1, 'z', 10, 1, 1)]);
  assert.equal(find(r.timeline, (t) => t.id === 'z' && t.type === 'auth').result, 'admitted');
  assert.deepEqual(find(r.timeline, (t) => t.type === 'expired'), { slot: 1, type: 'expired', id: 'z' });
});

test('same-slot events: capture/revoke processed before new auths, then priority/seq/id', () => {
  const r = run([
    auth(0, 'hold', 100, 5, 9),
    auth(1, 'low', 40, 0, 9),
    revoke(1, 'hold'),
    auth(1, 'high', 40, 2, 9),
  ]);
  // revoke runs first, freeing the pool, so even the low-priority auth fits.
  assert.equal(find(r.timeline, (t) => t.id === 'high' && t.type === 'auth').result, 'admitted');
  assert.equal(find(r.timeline, (t) => t.id === 'low' && t.type === 'auth').result, 'admitted');
  // ...and 'high' (higher priority) is admitted before 'low'.
  const order = r.timeline.filter((t) => t.type === 'auth' && t.slot === 1).map((t) => t.id);
  assert.deepEqual(order, ['high', 'low']);
});

test('pool shortage queues with POOL_SHORT; card limit is a hard rejection', () => {
  const r = run(
    [
      auth(0, 'big', 100, 5, 9),
      auth(1, 'q', 10, 1, 9),
      auth(1, 'over-card', 10, 1, 9, 'tiny'),
    ],
    { cards: { gold: 1000, tiny: 5 } },
  );
  assert.equal(find(r.timeline, (t) => t.id === 'q').result, 'queued');
  assert.ok(r.violations.some((v) => v.id === 'q' && v.code === 'POOL_SHORT'));
  assert.equal(find(r.timeline, (t) => t.id === 'over-card').result, 'rejected');
  assert.ok(r.violations.some((v) => v.id === 'over-card' && v.code === 'CARD_LIMIT'));
});

test('preemption: high priority preempts lower priority expiring soon', () => {
  const r = run([
    auth(0, 'victim', 60, 0, 3),
    auth(0, 'safe', 40, 1, 9),
    auth(1, 'hog', 60, 2, 6),
  ]);
  assert.deepEqual(find(r.timeline, (t) => t.type === 'preempted'), { slot: 1, type: 'preempted', id: 'victim', preemptedBy: 'hog' });
  assert.equal(find(r.timeline, (t) => t.id === 'hog' && t.type === 'auth').result, 'admitted');
  // pool stays exactly at capacity: 40 (safe) + 60 (hog)
  const cert = r.certificates.find((c) => c.slot === 1);
  assert.equal(cert.pool.used, 100);
  assert.ok(r.certificates.every(verifyCertificate));
});

test('preemption failure rolls back: victims untouched, PREEMPT_FORBID recorded', () => {
  const r = run([
    auth(0, 'a', 60, 0, 100), // lower priority but NOT expiring soon
    auth(0, 'b', 40, 1, 100), // lower priority but NOT expiring soon
    auth(1, 'h', 50, 2, 6),
  ]);
  assert.equal(find(r.timeline, (t) => t.id === 'h').result, 'queued');
  assert.equal(r.timeline.filter((t) => t.type === 'preempted').length, 0);
  assert.ok(r.violations.some((v) => v.id === 'h' && v.code === 'POOL_SHORT'));
  const forbid = r.violations.find((v) => v.code === 'PREEMPT_FORBID');
  assert.ok(forbid);
  assert.deepEqual(
    forbid.targets.map((t) => [t.id, t.reason]),
    [
      ['a', 'not-expiring-soon'],
      ['b', 'not-expiring-soon'],
    ],
  );
  // rollback check: both auths still hold their amounts
  const cert = r.certificates.find((c) => c.slot === 1);
  assert.equal(cert.pool.used, 100);
  assert.deepEqual(cert.active.map((a) => a.id).sort(), ['a', 'b']);
});

test('same-priority earlier-expiring auths cannot be preempted', () => {
  const r = run([
    auth(0, 'peer', 100, 1, 2), // expiring soon, but same priority
    auth(1, 'h', 50, 1, 6),
  ]);
  assert.equal(find(r.timeline, (t) => t.id === 'h').result, 'queued');
  const forbid = r.violations.find((v) => v.code === 'PREEMPT_FORBID');
  assert.deepEqual(forbid.targets, [{ id: 'peer', amount: 100, reason: 'same-or-higher-priority' }]);
});

test('captured auths are untouchable: CAPTURED on re-capture and revoke', () => {
  const r = run([
    auth(0, 'c', 50, 1, 9),
    capture(1, 'c'),
    capture(2, 'c'),
    revoke(3, 'c'),
  ]);
  const codes = r.violations.filter((v) => v.id === 'c').map((v) => v.code);
  assert.deepEqual(codes, ['CAPTURED', 'CAPTURED']);
});

test('revoke cascades into the waiting queue and emits wake proofs', () => {
  const r = run([
    auth(0, 'anchor', 100, 5, 50),
    auth(1, 'q1', 60, 1, 40),
    auth(2, 'q2', 40, 1, 40),
    revoke(5, 'anchor'),
  ]);
  assert.equal(r.wakes.length, 2);
  assert.deepEqual(
    r.wakes.map((w) => [w.woke, w.proof.freedBy, w.proof.poolBefore, w.proof.poolAfter]),
    [
      ['q1', ['anchor'], 0, 60],
      ['q2', ['anchor'], 60, 100],
    ],
  );
  assert.ok(r.certificates.every(verifyCertificate));
});

test('starvation bound: aged waiter wins over later same-priority arrivals', () => {
  const r = run([
    auth(0, 'A', 100, 5, 8),
    auth(0, 'W', 60, 1, 30),
    auth(1, 'B', 60, 1, 30),
    auth(2, 'C', 60, 1, 30),
  ]);
  const wake = r.wakes.find((w) => w.woke === 'W');
  assert.ok(wake, 'W must eventually be admitted');
  // Bound: W reached max aging at slot submit(0) + 2*agingK(2) = 4; the first
  // release at/after slot 4 is A's expiry at slot 8 -> W admitted at slot 8.
  assert.equal(wake.slot, 8);
  assert.equal(wake.proof.effectivePriority, 3); // 1 + 2 (max aging)
  assert.deepEqual(wake.proof.freedBy, ['A']);
  // W is the first wake; no later arrival is admitted before it.
  assert.equal(r.wakes[0].woke, 'W');
  assert.ok(r.wakes.every((w) => w.woke === 'W' || w.slot > wake.slot));
  assert.ok(results(r, 'C').some((t) => t.type === 'queue-expired'));
});

test('queued request expiring at a release slot is still admitted (boundary)', () => {
  const r = run([
    auth(0, 'anchor', 100, 5, 4),
    auth(0, 'q', 60, 1, 4), // expires at slot 4, the same slot anchor expires
  ]);
  const wake = r.wakes.find((w) => w.woke === 'q');
  assert.ok(wake);
  assert.equal(wake.slot, 4);
});

test('heap and naive strategies agree on a mixed scenario', () => {
  const events = [
    auth(0, 'a', 60, 0, 3),
    auth(0, 'b', 40, 1, 9),
    auth(1, 'c', 60, 2, 6),
    capture(2, 'c', 55),
    auth(4, 'd', 50, 1, 8),
    revoke(5, 'b'),
    auth(6, 'e', 90, 0, 7),
  ];
  const heapRun = run(events);
  const naiveRun = run(events, {}, 'naive');
  assert.deepEqual(naiveRun, heapRun);
});

test('determinism: identical inputs produce byte-identical results', () => {
  const events = [auth(0, 'a', 70, 1, 4), auth(0, 'b', 70, 2, 5), capture(3, 'a')];
  assert.equal(JSON.stringify(run(events)), JSON.stringify(run(events)));
});
