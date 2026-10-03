import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VM } from '../src/vm.js';
import { fold } from '../src/fold.js';
import { createHash } from 'node:crypto';

const ISIN = 'US0378331005';
const KEY = `2024-01-15|${ISIN}`;

function runAll(vm, events) {
  const results = [];
  for (const [i, text] of events.entries()) results.push(vm.applyEvent({ seq: i + 1, text }));
  return results;
}

test('acceptance 1: amend chain A1 -> A2 -> revoke A2 restores A1', () => {
  const vm = new VM();
  const [r1, r2, r3] = runAll(vm, [
    `trade A v1 on 2024-01-15 buy 100 ${ISIN} @ 150 net fee 1.5`,
    `amend A v2 on 2024-01-15 buy 120 ${ISIN} @ 150 net fee 1.5`,
    'revoke A v2 on 2024-01-15',
  ]);
  assert.ok(r1.ok && r2.ok && r3.ok);
  const s = vm.snapshot();
  assert.equal(s.trades.A.effective.version, 1);
  assert.deepEqual(s.trades.A.tombstoned, [2]);
  assert.equal(s.ledger[KEY].bought, 100);
  assert.equal(s.ledger[KEY].frozenCash, 100 * 150 + 1.5);

  // intermediate state after seq 2 shows the delta was applied, history kept
  const vm2 = new VM();
  runAll(vm2, [
    `trade A v1 on 2024-01-15 buy 100 ${ISIN} @ 150 net fee 1.5`,
    `amend A v2 on 2024-01-15 buy 120 ${ISIN} @ 150 net fee 1.5`,
  ]);
  assert.equal(vm2.snapshot().ledger[KEY].frozenCash, 120 * 150 + 1.5);
  assert.deepEqual(vm2.snapshot().trades.A.versions, [1, 2]);
});

test('acceptance 2: oversell freeze fails with E_NEG and leaves state unchanged', () => {
  const vm = new VM();
  assert.ok(vm.applyEvent({ seq: 1, text: `trade B v1 on 2024-01-15 buy 50 ${ISIN} @ 10 net` }).ok);
  const before = vm.snapshot();
  const r = vm.applyEvent({ seq: 2, text: `trade S v1 on 2024-01-15 sell 60 ${ISIN} @ 10 net` });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_NEG');
  assert.deepEqual(vm.snapshot(), before);
  assert.equal(vm.lastSeq, 1);
  // stream can continue with a corrected seq 2
  assert.ok(vm.applyEvent({ seq: 2, text: `trade S v1 on 2024-01-15 sell 40 ${ISIN} @ 10 net` }).ok);
  assert.equal(vm.snapshot().ledger[KEY].netShares, 10);
});

test('amend that turns position negative is rejected with E_NEG', () => {
  const vm = new VM();
  runAll(vm, [
    `trade B v1 on 2024-01-15 buy 50 ${ISIN} @ 10 net`,
    `trade S v1 on 2024-01-15 sell 40 ${ISIN} @ 10 net`,
  ]);
  const before = vm.snapshot();
  const r = vm.applyEvent({ seq: 3, text: `amend B v2 on 2024-01-15 buy 30 ${ISIN} @ 10 net` });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_NEG');
  assert.deepEqual(vm.snapshot(), before);
});

test('acceptance 3: same-seq replay is idempotent', () => {
  const vm = new VM();
  const evt = { seq: 1, text: `trade A v1 on 2024-01-15 buy 100 ${ISIN} @ 150 net fee 1.5` };
  assert.ok(vm.applyEvent(evt).ok);
  const s1 = vm.snapshot();
  const r = vm.applyEvent({ ...evt });
  assert.ok(r.ok);
  assert.equal(r.skipped, true);
  assert.deepEqual(vm.snapshot(), s1);
  // same seq, different payload is not a replay
  const bad = vm.applyEvent({ seq: 1, text: `trade A v1 on 2024-01-15 buy 99 ${ISIN} @ 150 net` });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_SEQ');
});

test('E_SEQ: gaps and out-of-order seq rejected', () => {
  const vm = new VM();
  assert.ok(vm.applyEvent({ seq: 1, text: `trade A v1 on 2024-01-15 buy 1 ${ISIN} @ 1 net` }).ok);
  const gap = vm.applyEvent({ seq: 3, text: `trade B v1 on 2024-01-15 buy 1 ${ISIN} @ 1 net` });
  assert.equal(gap.code, 'E_SEQ');
  assert.ok(vm.applyEvent({ seq: 2, text: `trade B v1 on 2024-01-15 buy 1 ${ISIN} @ 1 net` }).ok);
  const back = vm.applyEvent({ seq: 1, text: `trade C v1 on 2024-01-15 buy 1 ${ISIN} @ 1 net` });
  assert.equal(back.code, 'E_SEQ');
});

test('E_VERSION: unknown trade, duplicate trade, cross-date scope', () => {
  const vm = new VM();
  assert.equal(vm.applyEvent({ seq: 1, text: `amend X v1 on 2024-01-15 buy 1 ${ISIN} @ 1 net` }).code, 'E_VERSION');
  assert.equal(vm.applyEvent({ seq: 1, text: `revoke X v1 on 2024-01-15` }).code, 'E_VERSION');
  assert.ok(vm.applyEvent({ seq: 1, text: `trade A v1 on 2024-01-15 buy 1 ${ISIN} @ 1 net` }).ok);
  assert.equal(vm.applyEvent({ seq: 2, text: `trade A v1 on 2024-01-15 buy 1 ${ISIN} @ 1 net` }).code, 'E_VERSION');
  assert.equal(vm.applyEvent({ seq: 2, text: `amend A v2 on 2024-01-16 buy 1 ${ISIN} @ 1 net` }).code, 'E_VERSION');
  assert.equal(vm.applyEvent({ seq: 2, text: `revoke A v1 on 2024-01-16` }).code, 'E_VERSION');
});

test('pending correction is not a failure: stale/concurrent versions are kept', () => {
  const vm = new VM();
  const rs = runAll(vm, [
    `trade A v1 on 2024-01-15 buy 10 ${ISIN} @ 10 net`,
    `amend A v3 on 2024-01-15 buy 30 ${ISIN} @ 10 net`,
    `amend A v2 on 2024-01-15 buy 20 ${ISIN} @ 10 net`, // stale: v3 still effective
  ]);
  assert.ok(rs.every((r) => r.ok));
  const s = vm.snapshot();
  assert.equal(s.trades.A.effective.version, 3);
  assert.equal(s.ledger[KEY].bought, 30);
  assert.deepEqual(s.trades.A.versions, [1, 2, 3]);
});

test('concurrent same-version records tie-break by hash', () => {
  const mk = (qty) => `amend A v2 on 2024-01-15 buy ${qty} ${ISIN} @ 10 net`;
  const vm = new VM();
  runAll(vm, [`trade A v1 on 2024-01-15 buy 10 ${ISIN} @ 10 net`, mk(50), mk(70)]);
  const s = vm.snapshot();
  // both v2 records coexist; the effective one is the lexicographically smaller hash
  const h = (qty) => createHash('sha256').update(JSON.stringify(['A', 2, '2024-01-15', 'buy', qty, ISIN, 'net', 10, 0])).digest('hex');
  const expected = h(50) < h(70) ? 50 : 70;
  assert.equal(s.ledger[KEY].bought, expected);
  assert.equal(s.trades.A.effective.version, 2);
});

test('fold --at prefix: state at any seq prefix', () => {
  const events = [
    { seq: 1, text: `trade A v1 on 2024-01-15 buy 100 ${ISIN} @ 150 net` },
    { seq: 2, text: `trade B v1 on 2024-01-15 sell 40 ${ISIN} @ 151 net` },
    { seq: 3, text: `amend A v2 on 2024-01-15 buy 90 ${ISIN} @ 150 net` },
    { seq: 4, text: 'revoke A v2 on 2024-01-15' },
  ];
  const full = fold(events);
  assert.ok(full.ok);
  const at2 = fold(events, { at: 2 });
  assert.equal(at2.state.seq, 2);
  assert.equal(at2.state.ledger[KEY].bought, 100);
  assert.equal(at2.state.ledger[KEY].sold, 40);
  const at3 = fold(events, { at: 3 });
  assert.equal(at3.state.ledger[KEY].bought, 90);
  const at4 = fold(events, { at: 4 });
  assert.deepEqual(at4.state, full.state);
  assert.equal(at4.state.ledger[KEY].bought, 100);
  // fold reports the first failing event
  const bad = fold([...events, { seq: 5, text: `trade C v1 on 2024-01-15 sell 999 ${ISIN} @ 1 net` }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_NEG');
  assert.equal(bad.seq, 5);
});
