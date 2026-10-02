'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, verify, txHashOf, MachineError, GENESIS } = require('../lib/machine');

function tx(id, clock, amount) {
  return { id, type: 'tx', logicalClock: clock, amount };
}
function revoke(id, clock, txEvent, amount) {
  return { id, type: 'revoke', logicalClock: clock, txHash: txHashOf(txEvent), amount };
}
function unrevoke(id, clock, revokeId, amount) {
  return { id, type: 'unrevoke', logicalClock: clock, revokeId, amount };
}

test('acceptance 1: full revoke then unrevoke restores balance and quota', () => {
  const t1 = tx('t1', 1, 100);
  const r1 = revoke('r1', 2, t1, 100);
  const u1 = unrevoke('u1', 3, 'r1', 100);
  const { state, certs } = run([t1, r1, u1]);

  assert.equal(state.balance, 100);
  assert.equal(state.revocable, 100);
  assert.equal(state.txs[txHashOf(t1)].remaining, 100);
  assert.equal(state.revokes['r1'].unrevoked, 100);

  // intermediate states are visible through the cert chain
  assert.equal(certs.length, 3);
  assert.equal(certs[0].prevHash, GENESIS);
  assert.equal(certs[1].prevHash, certs[0].hash);
  assert.equal(certs[2].prevHash, certs[1].hash);
});

test('acceptance 2: two partial revokes reach boundary 0, further revoke rejected', () => {
  const t1 = tx('t1', 1, 100);
  const r1 = revoke('r1', 2, t1, 60);
  const r2 = revoke('r2', 3, t1, 40);
  const { state } = run([t1, r1, r2]);

  assert.equal(state.balance, 0);
  assert.equal(state.revocable, 0);
  assert.equal(state.txs[txHashOf(t1)].remaining, 0);

  const r3 = revoke('r3', 4, t1, 1);
  assert.throws(() => run([t1, r1, r2, r3]), (err) => {
    assert.ok(err instanceof MachineError);
    assert.equal(err.code, 'E_AMOUNT');
    return true;
  });
});

test('acceptance 3: out-of-order replay matches all 3-event permutations', () => {
  const t1 = tx('t1', 1, 100);
  const r1 = revoke('r1', 2, t1, 40);
  const u1 = unrevoke('u1', 3, 'r1', 15);
  const events = [t1, r1, u1];

  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2],
    [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const results = perms.map((p) => run(p.map((i) => events[i])));
  const first = results[0];
  for (const r of results) {
    assert.deepEqual(r.state, first.state);
    assert.equal(r.head, first.head);
    assert.deepEqual(r.certs, first.certs);
  }
  assert.equal(first.state.balance, 75); // 100 - 40 + 15
  assert.equal(first.state.revocable, 75);
});

test('acceptance 4: forged prevHash fails verification with E_CERT', () => {
  const t1 = tx('t1', 1, 100);
  const r1 = revoke('r1', 2, t1, 30);
  const result = run([t1, r1]);
  const bundle = {
    version: 1,
    head: result.head,
    state: result.state,
    certs: result.certs.map((c) => ({ ...c })),
    events: result.events,
  };
  bundle.certs[1].prevHash = 'f'.repeat(64); // forged link

  assert.throws(() => verify(bundle), (err) => {
    assert.equal(err.code, 'E_CERT');
    return true;
  });
});

test('idempotency: duplicate event id applied exactly once', () => {
  const t1 = tx('t1', 1, 100);
  const r1 = revoke('r1', 2, t1, 40);
  const once = run([t1, r1]);
  const twice = run([t1, r1, t1, r1, { ...r1 }]);
  assert.deepEqual(twice.state, once.state);
  assert.equal(twice.head, once.head);
  assert.equal(twice.certs.length, 2);
});

test('unrevoke cannot exceed restorable amount nor original tx cap', () => {
  const t1 = tx('t1', 1, 100);
  const r1 = revoke('r1', 2, t1, 40);
  const uTooMuch = unrevoke('u1', 3, 'r1', 41);
  assert.throws(() => run([t1, r1, uTooMuch]), /restorable/);

  // partial unrevoke then another unrevoke up to the remaining restorable
  const u1 = unrevoke('u1', 3, 'r1', 25);
  const u2 = unrevoke('u2', 4, 'r1', 15);
  const { state } = run([t1, r1, u1, u2]);
  assert.equal(state.balance, 100);
  assert.equal(state.revocable, 100);
  const u3 = unrevoke('u3', 5, 'r1', 1);
  assert.throws(() => run([t1, r1, u1, u2, u3]), (err) => err.code === 'E_AMOUNT');
});

test('revoke referencing unknown txHash fails with E_REF', () => {
  const bad = { id: 'r1', type: 'revoke', logicalClock: 1, txHash: 'a'.repeat(64), amount: 10 };
  assert.throws(() => run([bad]), (err) => err.code === 'E_REF');
});

test('unrevoke referencing unknown revokeId fails with E_REF', () => {
  const t1 = tx('t1', 1, 100);
  const bad = unrevoke('u1', 2, 'nope', 10);
  assert.throws(() => run([t1, bad]), (err) => err.code === 'E_REF');
});

test('verify accepts an untampered bundle', () => {
  const t1 = tx('t1', 1, 100);
  const r1 = revoke('r1', 2, t1, 30);
  const result = run([t1, r1]);
  const bundle = {
    version: 1,
    head: result.head,
    state: result.state,
    certs: result.certs,
    events: result.events,
  };
  const v = verify(bundle);
  assert.equal(v.ok, true);
  assert.equal(v.steps, 2);
  assert.equal(v.head, result.head);
});

test('tampered event amount fails verification with E_CERT', () => {
  const t1 = tx('t1', 1, 100);
  const r1 = revoke('r1', 2, t1, 30);
  const result = run([t1, r1]);
  const bundle = {
    version: 1,
    head: result.head,
    state: result.state,
    certs: result.certs,
    events: result.events.map((e) => ({ ...e })),
  };
  bundle.events[1].amount = 5; // tampered input
  assert.throws(() => verify(bundle), (err) => err.code === 'E_CERT');
});
