import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/engine.js';

const OK_LINES = [
  '{"type":"setRate","eid":"r1","pair":"USD/CNY","num":7,"den":1}',
  '{"type":"addInvoice","eid":"i1","id":"A","ccy":"USD","num":700,"den":1}',
  '{"type":"addInvoice","eid":"i2","id":"A","ccy":"CNY","num":-4900,"den":1}',
  '{"type":"addInvoice","eid":"i3","id":"B","ccy":"USD","num":-700,"den":1}',
  '{"type":"addInvoice","eid":"i4","id":"B","ccy":"CNY","num":2450,"den":1}',
  '{"type":"addInvoice","eid":"i5","id":"C","ccy":"CNY","num":2450,"den":1}',
];

const CONFLICT_LINES = [
  '{"type":"setRate","eid":"r1","pair":"USD/CNY","num":7,"den":1}',
  '{"type":"setRate","eid":"r2","pair":"CNY/EUR","num":1,"den":8}',
  '{"type":"setRate","eid":"r3","pair":"USD/EUR","num":9,"den":10}',
  '{"type":"addInvoice","eid":"i1","id":"A","ccy":"USD","num":100,"den":1}',
];

function ledgerOf(lines, opts) {
  const l = new Ledger(opts);
  lines.forEach((s, i) => l.applyLine(s, i + 1));
  return l;
}

test('acceptance 1: three parties, two currencies, nets sum to zero', () => {
  const r = ledgerOf(OK_LINES, { base: 'CNY' }).settle();
  assert.equal(r.status, 'ok');
  assert.equal(r.balanced, true);
  assert.equal(r.total, '0');
  const nets = Object.fromEntries(r.nets.map((n) => [n.party, n.exact]));
  assert.deepEqual(nets, { A: '0', B: '-2450', C: '2450' });
  assert.deepEqual(r.settlement.transfers, [{ from: 'B', to: 'C', amount: '2450' }]);
});

test('fractional amounts stay exact and rounding is deferred to posting', () => {
  const l = ledgerOf([
    '{"type":"addInvoice","eid":"i1","id":"A","ccy":"USD","num":1,"den":3}',
    '{"type":"addInvoice","eid":"i2","id":"B","ccy":"USD","num":-1,"den":3}',
  ]);
  const r = l.settle({ scale: 2 });
  assert.equal(r.status, 'ok');
  const a = r.nets.find((n) => n.party === 'A');
  assert.equal(a.exact, '1/3');
  assert.equal(a.posted, '0.33');
  assert.equal(a.roundingError, '1/300');
  assert.equal(a.roundingBound, '1/200');
});

test('pending (missing rate) is reported, never as infeasible', () => {
  const l = ledgerOf([
    '{"type":"setRate","eid":"r1","pair":"USD/CNY","num":7,"den":1}',
    '{"type":"addInvoice","eid":"i1","id":"A","ccy":"EUR","num":10,"den":1}',
  ]);
  const r = l.settle({ base: 'CNY' });
  assert.equal(r.status, 'pending');
  assert.notEqual(r.status, 'infeasible');
  assert.equal(r.error.code, 'E_PENDING');
  assert.deepEqual(r.error.missing, ['EUR']);
});

test('rate triangle conflict yields a minimal cycle certificate', () => {
  const r = ledgerOf(CONFLICT_LINES).settle({ base: 'CNY' });
  assert.equal(r.status, 'infeasible');
  const c = r.certificate;
  assert.equal(c.type, 'RATE_CYCLE_CONFLICT');
  assert.equal(c.steps.length, 3);
  assert.notEqual(c.product, '1');
  assert.equal(c.nodes[0], c.nodes[c.nodes.length - 1]);
});

test('correct adjusts values incrementally', () => {
  const l = ledgerOf([...OK_LINES, '{"type":"correct","eid":"c1","refId":"i4","newNum":2400,"newDen":1}'], {
    base: 'CNY',
  });
  const r = l.settle();
  const nets = Object.fromEntries(r.nets.map((n) => [n.party, n.exact]));
  assert.equal(nets.B, '-2500');
  assert.equal(nets.C, '2450');
  assert.equal(r.total, '-50');
  assert.equal(r.balanced, false);
  const l2 = ledgerOf([...OK_LINES, '{"type":"correct","eid":"c1","refId":"i5","newNum":2400,"newDen":1}'], {
    base: 'CNY',
  });
  const r2 = l2.settle();
  assert.equal(r2.total, '-50');
  assert.equal(r2.balanced, false);
});

test('undo removes effect; undoing the undo restores it', () => {
  const l = ledgerOf(OK_LINES, { base: 'CNY' });
  l.applyLine('{"type":"undo","eid":"u1","eventId":"i4"}', 7);
  let r = l.settle();
  let nets = Object.fromEntries(r.nets.map((n) => [n.party, n.exact]));
  assert.equal(nets.B, '-4900');
  assert.equal(r.total, '-2450');
  l.applyLine('{"type":"undo","eid":"u2","eventId":"u1"}', 8);
  r = l.settle();
  nets = Object.fromEntries(r.nets.map((n) => [n.party, n.exact]));
  assert.equal(nets.B, '-2450');
  assert.equal(r.total, '0');
});

test('undo of a correct restores the previous value', () => {
  const l = ledgerOf(
    [...OK_LINES, '{"type":"correct","eid":"c1","refId":"i5","newNum":100,"newDen":1}'],
    { base: 'CNY' }
  );
  let nets = Object.fromEntries(l.settle().nets.map((n) => [n.party, n.exact]));
  assert.equal(nets.C, '100');
  l.applyLine('{"type":"undo","eid":"u1","eventId":"c1"}', 8);
  nets = Object.fromEntries(l.settle().nets.map((n) => [n.party, n.exact]));
  assert.equal(nets.C, '2450');
});
