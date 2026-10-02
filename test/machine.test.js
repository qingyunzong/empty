'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  GENESIS_HASH,
  MachineError,
  buildSnapshot,
  canonicalize,
  eventHash,
  remainingReversible,
  runChain,
  verifySnapshot,
} = require('../lib/machine');

function tx(eventId, logicalClock, txId, amount) {
  return { type: 'tx', eventId, logicalClock, txId, amount };
}
function reversal(eventId, logicalClock, txHash, amount) {
  return { type: 'reversal', eventId, logicalClock, txHash, amount };
}
function reinstate(eventId, logicalClock, reversalHash, amount) {
  return { type: 'reinstate', eventId, logicalClock, reversalHash, amount };
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

test('canonical JSON sorts keys and is stable', () => {
  assert.equal(canonicalize({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonicalize([1, 'x', null, true]), '[1,"x",null,true]');
  assert.throws(() => canonicalize({ x: NaN }));
});

test('acceptance 1: full reversal then reinstate restores balance and capacity', () => {
  const t1 = tx('e1', 1, 't1', 100);
  const txHash = eventHash(t1);
  const r1 = reversal('e2', 2, txHash, 100);
  const revHash = eventHash(r1);
  const i1 = reinstate('e3', 3, revHash, 100);

  const { state, certs } = runChain([t1, r1, i1]);
  assert.equal(state.balance, 100);
  assert.equal(remainingReversible(state.txs[txHash]), 100);
  assert.equal(state.reversals[revHash].reinstated, 100);
  assert.equal(certs.length, 3);

  // intermediate states: after full reversal balance was 0
  const snap = buildSnapshot([t1, r1, i1]);
  assert.equal(snap.final.balance, 100);
  assert.deepEqual(snap.final.reversible[txHash], [0, 100]);
});

test('reinstate cannot exceed what was reversed (original tx cap)', () => {
  const t1 = tx('e1', 1, 't1', 100);
  const txHash = eventHash(t1);
  const r1 = reversal('e2', 2, txHash, 60);
  const revHash = eventHash(r1);
  const i1 = reinstate('e3', 3, revHash, 61);
  assert.throws(() => runChain([t1, r1, i1]), (err) => {
    assert.equal(err.code, 'E_AMOUNT');
    return true;
  });
});

test('acceptance 2: two partial reversals hit exact 0 boundary, next one rejected', () => {
  const t1 = tx('e1', 1, 't1', 100);
  const txHash = eventHash(t1);
  const r1 = reversal('e2', 2, txHash, 60);
  const r2 = reversal('e3', 3, txHash, 40);

  const { state } = runChain([t1, r1, r2]);
  assert.equal(state.balance, 0);
  assert.equal(remainingReversible(state.txs[txHash]), 0);

  const r3 = reversal('e4', 4, txHash, 1);
  assert.throws(() => runChain([t1, r1, r2, r3]), (err) => {
    assert.equal(err.code, 'E_AMOUNT');
    return true;
  });
});

test('reversal referencing unknown tx hash is rejected', () => {
  const r1 = reversal('e1', 1, 'deadbeef', 10);
  assert.throws(() => runChain([r1]), (err) => {
    assert.equal(err.code, 'E_UNKNOWN_TX');
    return true;
  });
});

test('acceptance 3: out-of-order submission replays by (logicalClock, eventId); all 3-event permutations agree', () => {
  const t1 = tx('e1', 1, 't1', 100);
  const txHash = eventHash(t1);
  const r1 = reversal('e2', 2, txHash, 30);
  const revHash = eventHash(r1);
  const i1 = reinstate('e3', 3, revHash, 10);
  const events = [t1, r1, i1];

  const reference = buildSnapshot(events);
  const perms = permutations(events);
  assert.equal(perms.length, 6);
  for (const perm of perms) {
    const snap = buildSnapshot(perm);
    assert.equal(snap.final.stateHash, reference.final.stateHash);
    assert.equal(snap.final.balance, 80);
    assert.equal(snap.certs.length, 3);
    assert.deepEqual(
      snap.certs.map((c) => c.certHash),
      reference.certs.map((c) => c.certHash)
    );
  }
});

test('same logicalClock falls back to eventId ordering', () => {
  const t1 = tx('e1', 1, 't1', 50);
  const t2 = tx('e2', 1, 't2', 70);
  const a = buildSnapshot([t1, t2]);
  const b = buildSnapshot([t2, t1]);
  assert.equal(a.final.stateHash, b.final.stateHash);
  assert.equal(a.final.balance, 120);
});

test('duplicate eventId is idempotent (applied once)', () => {
  const t1 = tx('e1', 1, 't1', 100);
  const txHash = eventHash(t1);
  const r1 = reversal('e2', 2, txHash, 40);
  const snap = buildSnapshot([t1, r1, r1, { ...r1, amount: 40 }]);
  assert.equal(snap.final.balance, 60);
  assert.equal(snap.certs.length, 2);
  assert.deepEqual(snap.duplicates, ['e2', 'e2']);
});

test('certificate chain links prevHash -> certHash from genesis', () => {
  const t1 = tx('e1', 1, 't1', 100);
  const txHash = eventHash(t1);
  const r1 = reversal('e2', 2, txHash, 25);
  const { certs } = runChain([t1, r1]);
  assert.equal(certs[0].prevHash, GENESIS_HASH);
  assert.equal(certs[1].prevHash, certs[0].certHash);
  assert.equal(certs[0].seq, 0);
  assert.equal(certs[1].seq, 1);
  assert.match(certs[0].certHash, /^[0-9a-f]{64}$/);
  assert.match(certs[0].stateHash, /^[0-9a-f]{64}$/);
});

test('acceptance 4: forged prevHash fails verification with E_CERT', () => {
  const t1 = tx('e1', 1, 't1', 100);
  const txHash = eventHash(t1);
  const r1 = reversal('e2', 2, txHash, 25);
  const snap = buildSnapshot([t1, r1]);

  const forged = JSON.parse(JSON.stringify(snap));
  forged.certs[1].prevHash = '0'.repeat(64);
  assert.throws(() => verifySnapshot(forged), (err) => {
    assert.ok(err instanceof MachineError);
    assert.equal(err.code, 'E_CERT');
    return true;
  });
});

test('verify detects tampered event amount and tampered final balance', () => {
  const t1 = tx('e1', 1, 't1', 100);
  const txHash = eventHash(t1);
  const r1 = reversal('e2', 2, txHash, 25);
  const snap = buildSnapshot([t1, r1]);
  assert.equal(verifySnapshot(snap).ok, true);

  const tamperedEvent = JSON.parse(JSON.stringify(snap));
  tamperedEvent.events[1].amount = 5;
  assert.throws(() => verifySnapshot(tamperedEvent), { code: 'E_CERT' });

  const tamperedFinal = JSON.parse(JSON.stringify(snap));
  tamperedFinal.final.balance = 999999;
  assert.throws(() => verifySnapshot(tamperedFinal), { code: 'E_CERT' });
});

test('malformed events are rejected with E_BAD_EVENT', () => {
  assert.throws(() => runChain([{ type: 'tx', eventId: 'e1', logicalClock: 1, amount: -5, txId: 't' }]), { code: 'E_BAD_EVENT' });
  assert.throws(() => runChain([{ type: 'nope', eventId: 'e1', logicalClock: 1, amount: 5 }]), { code: 'E_BAD_EVENT' });
  assert.throws(() => runChain(['not-an-object']), { code: 'E_BAD_EVENT' });
});
