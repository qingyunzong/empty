'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../engine');
const { TYPE } = require('../frame');

const reserve = (member, reqId, amount, seq) => ({ type: TYPE.RESERVE, member, reqId, amount, seq });
const commit = (member, reqId, amount, seq) => ({ type: TYPE.COMMIT, member, reqId, amount, seq });
const release = (member, reqId, amount, seq) => ({ type: TYPE.RELEASE, member, reqId, amount, seq });
const expire = (to, seq) => ({ type: TYPE.EXPIRE, member: 'SYS', reqId: 0, amount: to, seq });

test('reserve: accept, partial, reject as budget runs out', () => {
  const e = new Engine({ budget: 100 });
  assert.equal(e.process(reserve('A', 1, 60, 1)).decision, 'accept');
  const p = e.process(reserve('B', 1, 60, 1));
  assert.equal(p.decision, 'partial');
  assert.equal(p.got, 40);
  const r = e.process(reserve('C', 1, 10, 1));
  assert.equal(r.decision, 'reject');
  assert.equal(e.budgetLeft(), 0);
  assert.ok(e.exitFlags.has('over_budget'));
});

test('reserve with same reqId is idempotent (no double grant, no extra log record)', () => {
  const e = new Engine({ budget: 100 });
  const first = e.process(reserve('A', 1, 60, 1));
  const again = e.process(reserve('A', 1, 60, 2));
  assert.equal(again.dup, true);
  assert.equal(again.got, first.got);
  assert.equal(e.budgetLeft(), 40);
  assert.equal(e.log.length, 1);
});

test('commit consumes only own live reservation; duplicate commit does not double-charge', () => {
  const e = new Engine({ budget: 100 });
  e.process(reserve('A', 1, 60, 1));
  const c1 = e.process(commit('A', 1, 60, 2));
  assert.equal(c1.got, 60);
  assert.equal(e.committedTotal, 60);
  const c2 = e.process(commit('A', 1, 60, 3)); // reservation fully committed
  assert.equal(c2.decision, 'accept');
  assert.equal(c2.got, 0);
  assert.equal(e.committedTotal, 60); // unchanged
  // commit on someone else's / unknown reqId is rejected
  const c3 = e.process(commit('B', 1, 10, 1));
  assert.equal(c3.decision, 'reject');
  assert.equal(c3.reason, 'unknown-reqId');
  assert.ok(e.exitFlags.has('unknown_req'));
});

test('partial commits accumulate up to the reserved amount', () => {
  const e = new Engine({ budget: 100 });
  e.process(reserve('A', 1, 50, 1));
  assert.equal(e.process(commit('A', 1, 20, 2)).got, 20);
  assert.equal(e.process(commit('A', 1, 999, 3)).got, 30); // capped at remaining
  assert.equal(e.committedTotal, 50);
});

test('release is idempotent', () => {
  const e = new Engine({ budget: 100 });
  e.process(reserve('A', 1, 60, 1));
  assert.equal(e.process(release('A', 1, 60, 2)).got, 60);
  assert.equal(e.budgetLeft(), 100);
  const again = e.process(release('A', 1, 60, 3));
  assert.equal(again.got, 0);
  assert.equal(e.budgetLeft(), 100);
});

test('out-of-order release before reserve is buffered and applied on arrival', () => {
  const e = new Engine({ budget: 100 });
  const buffered = e.process(release('A', 1, 40, 1));
  assert.equal(buffered.decision, 'buffered');
  const r = e.process(reserve('A', 1, 60, 2));
  assert.equal(r.decision, 'accept');
  assert.equal(r.got, 60);
  assert.equal(e.budgetLeft(), 80); // 60 granted, 40 immediately released
  const res = e.reservations.get('A#1');
  assert.equal(res.remaining, 20);
});

test('unresolved buffered release flags unknown_req at finalize', () => {
  const e = new Engine({ budget: 100 });
  e.process(release('A', 7, 10, 1));
  e.finalize();
  assert.ok(e.exitFlags.has('unknown_req'));
});

test('virtual clock expire releases reservation and emits audit event; late commit rejected', () => {
  const e = new Engine({ budget: 100, ttl: 50 });
  e.process(reserve('A', 1, 60, 1)); // expires at t=50
  const exp = e.process(expire(50, 1));
  assert.equal(exp.events.length, 1);
  assert.deepEqual(exp.events[0], { member: 'A', reqId: 1, released: 60 });
  assert.equal(e.budgetLeft(), 100);
  const late = e.process(commit('A', 1, 60, 2));
  assert.equal(late.decision, 'reject');
  assert.equal(late.reason, 'expired');
  assert.equal(e.committedTotal, 0);
});

test('commit just before expiry tick still succeeds (expire is at-point)', () => {
  const e = new Engine({ budget: 100, ttl: 50 });
  e.process(reserve('A', 1, 60, 1));
  e.process(expire(49, 1));
  assert.equal(e.process(commit('A', 1, 60, 2)).got, 60);
});

test('expire audit events follow deterministic tie-break order (member, then reqId)', () => {
  const e = new Engine({ budget: 1000, ttl: 10 });
  e.process(reserve('BOB', 2, 50, 1));
  e.process(reserve('ALICE', 9, 50, 1));
  e.process(reserve('ALICE', 3, 50, 2));
  const exp = e.process(expire(10, 1));
  assert.deepEqual(exp.events.map((ev) => `${ev.member}#${ev.reqId}`), ['ALICE#3', 'ALICE#9', 'BOB#2']);
});

test('no retroactive re-judgment: earlier grants are never revised by later arrivals', () => {
  const e = new Engine({ budget: 100 });
  const g1 = e.process(reserve('ZZZ', 1, 70, 1));
  assert.equal(g1.got, 70);
  // a lexicographically smaller member arriving later cannot evict the grant
  const g2 = e.process(reserve('AAA', 1, 70, 1));
  assert.equal(g2.got, 30);
  assert.equal(e.reservations.get('ZZZ#1').remaining, 70);
});

test('every decision is appended to the log and moves the Merkle root', () => {
  const e = new Engine({ budget: 100 });
  const roots = new Set();
  roots.add(e.log.root());
  for (const f of [reserve('A', 1, 10, 1), commit('A', 1, 5, 2), release('A', 1, 5, 3), expire(1000, 1)]) {
    e.process(f);
    roots.add(e.log.root());
  }
  assert.equal(e.log.length, 4);
  assert.equal(roots.size, 5);
});
