'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../lib/core');
const { AppendOnlyLog } = require('../lib/log');
const { TYPE } = require('../lib/frame');

function run(frames, { budgetCap = 1000, ttl = 100 } = {}) {
  const entries = [];
  const engine = new Engine({
    budgetCap, ttl,
    log: new AppendOnlyLog(null),
    emit: (e) => entries.push(e),
  });
  for (const f of frames) engine.ingest(f);
  engine.flush();
  return { engine, entries };
}

const R = (member, reqId, amount, seq, tick) => ({ type: TYPE.RESERVE, member, reqId, amount, seq, tick });
const C = (member, reqId, amount, seq, tick) => ({ type: TYPE.COMMIT, member, reqId, amount, seq, tick });
const L = (member, reqId, seq, tick) => ({ type: TYPE.RELEASE, member, reqId, amount: 0, seq, tick });
const X = (member, reqId, seq, tick) => ({ type: TYPE.EXPIRE, member, reqId, amount: 0, seq, tick });

// --- acceptance 1: concurrent reserves exceeding the budget ---------------

test('acceptance 1: concurrent reserves over budget are allocated by priority', () => {
  const { engine, entries } = run([
    R('carol', 3, 60, 1, 0),
    R('alice', 1, 60, 2, 0),
    R('bob', 2, 50, 3, 0),
  ], { budgetCap: 100 });
  // priority: amount asc, then member, then reqId -> bob(50), alice(60), carol(60)
  const byReq = new Map(entries.map((e) => [e.reqId, e]));
  assert.deepEqual(
    entries.map((e) => `${e.member}:${e.status}:${e.granted}`),
    ['bob:accept:50', 'alice:partial:50', 'carol:reject:0'],
  );
  assert.equal(byReq.get(3).reason, 'budget');
  assert.equal(engine.firstError, 3); // over budget -> exit 3
  assert.equal(engine.remainingBudget(), 0);
});

test('acceptance 1: same amount + same tick is settled by member then reqId', () => {
  const { entries } = run([
    R('bob', 2, 40, 1, 5),
    R('alice', 1, 40, 2, 5),
  ], { budgetCap: 40 });
  assert.deepEqual(entries.map((e) => `${e.member}:${e.status}`), ['alice:accept', 'bob:reject']);
  // same member, tie settled by reqId
  const again = run([R('alice', 9, 40, 1, 0), R('alice', 3, 40, 2, 0)], { budgetCap: 40 });
  assert.deepEqual(again.entries.map((e) => `${e.reqId}:${e.status}`), ['3:accept', '9:reject']);
});

test('reserve decisions are never re-judged (idempotent retransmission)', () => {
  const { engine, entries } = run([
    R('alice', 1, 60, 1, 0),
    R('bob', 2, 60, 2, 1),   // partial 40
    R('alice', 1, 60, 3, 2), // retransmission of reqId 1
  ], { budgetCap: 100 });
  assert.equal(entries[2].dup, true);
  assert.equal(entries[2].granted, 60);
  assert.equal(engine.reservedTotal(), 100);
});

// --- acceptance 2: duplicate commit must not double-spend -----------------

test('acceptance 2: duplicate commit does not double-deduct', () => {
  const { engine, entries } = run([
    R('alice', 1, 100, 1, 0),
    C('alice', 1, 100, 2, 1),
    C('alice', 1, 100, 3, 2), // application-level retry, new seq
  ], { budgetCap: 1000 });
  assert.equal(entries[1].status, 'accept');
  assert.equal(entries[2].status, 'accept');
  assert.equal(entries[2].dup, true);
  assert.equal(engine.used, 100); // spent exactly once
  assert.equal(engine.remainingBudget(), 900);
});

test('commit consumes only the caller\'s own live reservation', () => {
  const { entries } = run([
    R('alice', 1, 100, 1, 0),
    C('bob', 1, 100, 2, 1),   // wrong member
    C('alice', 1, 150, 3, 2), // more than reserved
  ], { budgetCap: 1000 });
  assert.equal(entries[1].reason, 'member-mismatch');
  assert.equal(entries[2].reason, 'amount-exceeds-reserved');
});

// --- acceptance 3: out-of-order release is parked until its reserve -------

test('acceptance 3: release arriving before its reserve is parked, then applied', () => {
  const { engine, entries } = run([
    L('alice', 7, 1, 0),      // release first: reqId 7 unknown -> parked
    R('alice', 7, 80, 2, 5),  // reserve later -> drains the parked release
  ], { budgetCap: 100 });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'reserve');
  assert.equal(entries[0].status, 'accept');
  assert.equal(entries[1].kind, 'release');
  assert.equal(entries[1].seq, 1);
  assert.equal(entries[1].released, 80);
  assert.equal(engine.reservedTotal(), 0);
  assert.equal(engine.remainingBudget(), 100);
  assert.equal(engine.firstError, 0); // parked op resolved, not an unknown reqId
});

test('release is idempotent', () => {
  const { engine, entries } = run([
    R('alice', 1, 50, 1, 0),
    L('alice', 1, 2, 1),
    L('alice', 1, 3, 2),
  ], { budgetCap: 100 });
  assert.equal(entries[1].released, 50);
  assert.equal(entries[2].status, 'accept');
  assert.equal(entries[2].released, 0);
  assert.equal(entries[2].noop, true);
  assert.equal(engine.remainingBudget(), 100);
});

// --- acceptance 4: virtual-clock expire and a late commit -----------------

test('acceptance 4: TTL expiry releases budget and rejects the late commit', () => {
  const { engine, entries } = run([
    R('alice', 1, 400, 1, 0),   // expireTick = 0 + ttl(10)
    R('bob', 2, 100, 2, 20),    // clock jumps to 20 -> alice auto-expires first
    C('alice', 1, 400, 3, 21),  // too late
  ], { budgetCap: 1000, ttl: 10 });
  const audit = entries.find((e) => e.auto);
  assert.ok(audit, 'an auto-expire audit event is emitted');
  assert.equal(audit.kind, 'expire');
  assert.equal(audit.reqId, 1);
  assert.equal(audit.released, 400);
  assert.equal(audit.tick, 20);
  const lateCommit = entries[entries.length - 1];
  assert.equal(lateCommit.status, 'reject');
  assert.equal(lateCommit.reason, 'not-active');
  assert.equal(engine.used, 0);
  assert.equal(engine.remainingBudget(), 900);
});

test('acceptance 4: explicit expire frame releases at its tick with an audit entry', () => {
  const { engine, entries } = run([
    R('alice', 1, 200, 1, 0),
    X('alice', 1, 2, 5),
    C('alice', 1, 200, 3, 6),
  ], { budgetCap: 1000, ttl: 1000 });
  assert.equal(entries[1].kind, 'expire');
  assert.equal(entries[1].status, 'accept');
  assert.equal(entries[1].released, 200);
  assert.equal(entries[2].reason, 'not-active');
  assert.equal(engine.remainingBudget(), 1000);
});

test('commit at exactly the expiry tick is already too late', () => {
  const { entries } = run([
    R('alice', 1, 100, 1, 0),
    C('alice', 1, 100, 2, 10), // expireTick == 10
  ], { budgetCap: 1000, ttl: 10 });
  assert.equal(entries[entries.length - 1].reason, 'not-active');
});

// --- supporting behaviour ---------------------------------------------------

test('unknown reqId at end of input is rejected and flagged as exit 4', () => {
  const { engine, entries } = run([C('alice', 99, 10, 1, 0)]);
  assert.equal(entries[0].status, 'reject');
  assert.equal(entries[0].reason, 'unknown-reqid');
  assert.equal(engine.firstError, 4);
});

test('every judgement is hash-chained into the append-only log', () => {
  const { engine } = run([
    R('alice', 1, 100, 1, 0),
    C('alice', 1, 40, 2, 1),
    L('alice', 1, 3, 2),
  ]);
  const log = new AppendOnlyLog(null);
  for (const e of engine.log.entries) log.append((( { hash, root, ...body }) => body)(e));
  assert.equal(log.root(), engine.log.root());
  assert.ok(engine.log.entries.every((e) => typeof e.root === 'string' && e.root.length === 64));
});
