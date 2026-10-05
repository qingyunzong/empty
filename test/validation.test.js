// Error codes and certificate verification units.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffLedgers, verifyCertificate, LedgerAutomaton, ReconError, ERR,
} from '../src/index.js';
import { MAX_EVENTS } from '../src/ledger.js';
import { ev, pair } from './helpers.js';

test('DUP_ID: duplicate event id within one ledger', () => {
  const left = [ev('a', 'cash', 1, 'debit', 'USD', 'r1'), ev('a', 'cash', 1, 'credit', 'USD', 'r1')];
  assert.throws(() => diffLedgers(left, []), (e) => e instanceof ReconError && e.code === ERR.DUP_ID);
});

test('CURRENCY_MIX: one relId carrying two currencies', () => {
  const left = [
    ev('a', 'cash', 1, 'debit', 'USD', 'r1'),
    ev('b', 'cash', 1, 'credit', 'EUR', 'r1'),
  ];
  assert.throws(() => diffLedgers(left, []), (e) => e.code === ERR.CURRENCY_MIX);
});

test('INPUT_TOO_LARGE: more than 200 events per ledger', () => {
  const left = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ev(`e${i}`, 'cash', 1, 'debit', 'USD', `r${i}`));
  assert.throws(() => diffLedgers(left, []), (e) => e.code === 'INPUT_TOO_LARGE');
});

test('CERT_INVALID: tampered productState is rejected', () => {
  const left = [...pair('l1', 'l2', { relId: 'r1' }), ev('lx', 'cash', 5, 'debit', 'USD', 'rx')];
  const right = pair('r1', 'r2', { relId: 'r1' });
  const res = diffLedgers(left, right, { k: 5 });
  assert.deepEqual(verifyCertificate(left, right, res.certificate), { valid: true });
  const tampered = { ...res.certificate, productState: { ...res.certificate.productState, exposure: {} } };
  assert.throws(() => verifyCertificate(left, right, tampered), (e) => e.code === ERR.CERT_INVALID);
});

test('CERT_INVALID: truncated prefix claim is rejected', () => {
  const left = [...pair('l1', 'l2', { relId: 'r1' }), ev('lx', 'cash', 5, 'debit', 'USD', 'rx')];
  const right = pair('r1', 'r2', { relId: 'r1' });
  const res = diffLedgers(left, right, { k: 5 });
  const tampered = { ...res.certificate, leftPrefix: res.certificate.leftPrefix.slice(0, -1) };
  assert.throws(() => verifyCertificate(left, right, tampered), (e) => e.code === ERR.CERT_INVALID);
});

test('CERT_INVALID: fabricated continuation is rejected', () => {
  const left = [...pair('l1', 'l2', { relId: 'r1' }), ev('lx', 'cash', 5, 'debit', 'USD', 'rx')];
  const right = pair('r1', 'r2', { relId: 'r1' });
  const res = diffLedgers(left, right, { k: 5 });
  const tampered = { ...res.certificate, continuation: [{ op: 'removeExtra', side: 'right', id: 'nope' }] };
  assert.throws(() => verifyCertificate(left, right, tampered), (e) => e.code === ERR.CERT_INVALID);
});

test('LedgerAutomaton enforces per-account causal order', () => {
  const events = [
    ev('a', 'cash', 1, 'debit', 'USD', 'r1'),
    ev('b', 'cash', 2, 'debit', 'USD', 'r2'),
  ];
  const auto = new LedgerAutomaton(events);
  const s0 = auto.initialState();
  assert.throws(() => auto.consume(s0, 1), /causal order/);
  const s1 = auto.consume(s0, 0);
  assert.doesNotThrow(() => auto.consume(s1, 1));
});

test('co-optimal script enumeration is capped at 20 in the public result', () => {
  // 5 independent surplus balanced pairs -> 2^5 = 32 co-optimal scripts
  // (remove each pair from the left, or add it to the right); only 20 are
  // reported while scriptCount keeps the full tally.
  const left = [];
  for (let i = 0; i < 5; i += 1) {
    left.push(...pair(`x${i}a`, `x${i}b`, { relId: `rx${i}`, amount: i + 1 }));
  }
  const res = diffLedgers(left, [], { k: 10 });
  assert.equal(res.minCost, 10);
  assert.equal(res.scriptCount, 32);
  assert.equal(res.scripts.length, 20);
});
