import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/engine.js';

const BASE_LINES = [
  '{"type":"setRate","eid":"r1","pair":"USD/CNY","num":7,"den":1}',
  '{"type":"addInvoice","eid":"i1","id":"A","ccy":"USD","num":700,"den":1}',
  '{"type":"addInvoice","eid":"i2","id":"A","ccy":"CNY","num":-4900,"den":1}',
  '{"type":"addInvoice","eid":"i3","id":"B","ccy":"USD","num":-700,"den":1}',
  '{"type":"addInvoice","eid":"i4","id":"B","ccy":"CNY","num":2450,"den":1}',
  '{"type":"addInvoice","eid":"i5","id":"C","ccy":"CNY","num":2450,"den":1}',
];

function freshHash(lines) {
  const l = new Ledger();
  lines.forEach((s, i) => l.applyLine(s, i + 1));
  return l.historyHash();
}

test('acceptance 4: undo makes history hash equal to the reduced log', () => {
  const l = new Ledger();
  BASE_LINES.forEach((s, i) => l.applyLine(s, i + 1));
  const h0 = l.historyHash();
  l.applyLine('{"type":"undo","eid":"u1","eventId":"i4"}', 7);
  const reduced = BASE_LINES.filter((_, i) => i !== 4);
  assert.equal(l.historyHash(), freshHash(reduced));
  assert.notEqual(l.historyHash(), h0);
  l.applyLine('{"type":"undo","eid":"u2","eventId":"u1"}', 8);
  assert.equal(l.historyHash(), h0, 'undoing the undo must restore the original hash');
});

test('correct then undo restores the historical hash', () => {
  const l = new Ledger();
  BASE_LINES.forEach((s, i) => l.applyLine(s, i + 1));
  const h0 = l.historyHash();
  l.applyLine('{"type":"correct","eid":"c1","refId":"i4","newNum":2400,"newDen":1}', 7);
  const corrected = BASE_LINES.map((s, i) =>
    i === 4 ? '{"type":"addInvoice","eid":"i4","id":"B","ccy":"CNY","num":2400,"den":1}' : s
  );
  assert.equal(l.historyHash(), freshHash(corrected));
  l.applyLine('{"type":"undo","eid":"u1","eventId":"c1"}', 8);
  assert.equal(l.historyHash(), h0);
});

test('correct/undo never reprocess more than N=2000 events', () => {
  const l = new Ledger();
  const lines = ['{"type":"setRate","eid":"r1","pair":"USD/CNY","num":7,"den":1}'];
  const n = 3000;
  for (let i = 0; i < n; i += 1) {
    lines.push(
      `{"type":"addInvoice","eid":"i${i}","id":"P${i % 3}","ccy":"USD","num":${(i % 7) - 3},"den":1}`
    );
  }
  lines.forEach((s, i) => l.applyLine(s, i + 1));
  l.applyLine('{"type":"correct","eid":"c1","refId":"i0","newNum":5,"newDen":1}', n + 2);
  l.applyLine('{"type":"undo","eid":"u1","eventId":"i1"}', n + 3);
  const stats = l.stats();
  assert.ok(
    stats.eventsReprocessed <= 2000,
    `eventsReprocessed ${stats.eventsReprocessed} exceeds N=2000`
  );
  const expected = lines.map((s, i) =>
    i === 1 ? '{"type":"addInvoice","eid":"i0","id":"P0","ccy":"USD","num":5,"den":1}' : s
  );
  expected.splice(2, 1); // i1 undone
  assert.equal(l.historyHash(), freshHash(expected));
});
