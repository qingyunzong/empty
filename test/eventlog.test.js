import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog, parseEvent, loadLog, referenceHash, CodedError } from '../src/eventlog.js';
import { mulberry32, randInt } from './helpers.js';

const line = (obj) => JSON.stringify(obj);

function logOf(lines) {
  return loadLog(lines.map(line).join('\n'));
}

test('E_PARSE on malformed input', () => {
  assert.throws(() => parseEvent('{not json', 1), (e) => e.code === 'E_PARSE' && e.line === 1);
  assert.throws(() => parseEvent('{"frobnicate":{}}', 2), (e) => e.code === 'E_PARSE');
  assert.throws(() => parseEvent('{"addInvoice":{"id":"A","ccy":"CNY","num":1,"den":0}}', 3), (e) => e.code === 'E_PARSE');
  assert.throws(() => parseEvent('{"setRate":{"pair":"usd/cny","num":7}}', 4), (e) => e.code === 'E_PARSE');
  assert.throws(() => parseEvent('{"setRate":{"pair":"USD/CNY","num":-7}}', 5), (e) => e.code === 'E_PARSE');
  assert.throws(() => parseEvent('{"op":"undo"}', 6), (e) => e.code === 'E_PARSE');
});

test('E_REF on unknown references and duplicates', () => {
  const log = logOf([{ addInvoice: { id: 'A:1', ccy: 'CNY', num: 1 } }]);
  assert.throws(
    () => log.append(parseEvent(line({ undo: { eventId: 'evt:99' } }), 2)),
    (e) => e.code === 'E_REF'
  );
  assert.throws(
    () => log.append(parseEvent(line({ correct: { refId: 'B:1', newNum: 2 } }), 2)),
    (e) => e.code === 'E_REF'
  );
  assert.throws(
    () => log.append(parseEvent(line({ addInvoice: { id: 'A:1', ccy: 'CNY', num: 2 } }), 2)),
    (e) => e.code === 'E_REF'
  );
  // double undo
  log.append(parseEvent(line({ undo: { eventId: 'evt:1' } }), 2));
  assert.throws(
    () => log.append(parseEvent(line({ undo: { eventId: 'evt:1' } }), 3)),
    (e) => e.code === 'E_REF'
  );
});

test('acceptance 4: undo restores the historical hash', () => {
  const log = logOf([
    { addInvoice: { id: 'A:1', ccy: 'CNY', num: 100 } },
    { addInvoice: { id: 'B:1', ccy: 'CNY', num: -100 } },
  ]);
  const before = log.head;
  log.append(parseEvent(line({ addInvoice: { id: 'C:1', ccy: 'CNY', num: 5 } }), 3));
  const withC = log.head;
  assert.notEqual(withC, before);
  log.append(parseEvent(line({ undo: { eventId: 'evt:3' } }), 4));
  assert.equal(log.head, before);
  assert.equal(log.hashTrail[3], log.hashTrail[1]);

  // correct changes the hash; undoing the correct restores it
  log.append(parseEvent(line({ correct: { refId: 'A:1', newNum: 120 } }), 5));
  const corrected = log.head;
  assert.notEqual(corrected, before);
  assert.equal(log.invoices()[0].amount.n, 120n);
  log.append(parseEvent(line({ undo: { eventId: 'evt:5' } }), 6));
  assert.equal(log.head, before);
  assert.equal(log.invoices()[0].amount.n, 100n);

  // undo of an undo reactivates the original event
  const log2 = logOf([
    { addInvoice: { id: 'A:1', ccy: 'CNY', num: 7 } },
    { undo: { eventId: 'evt:1' } },
  ]);
  assert.equal(log2.invoices().length, 0);
  log2.append(parseEvent(line({ undo: { eventId: 'evt:2' } }), 3));
  assert.equal(log2.invoices().length, 1);
  assert.equal(log2.head, logOf([{ addInvoice: { id: 'A:1', ccy: 'CNY', num: 7 } }]).head);
});

test('incremental: 2500 events, correct/undo never recompute the prefix', () => {
  const rng = mulberry32(42);
  const log = new EventLog();
  let lineno = 0;
  for (let i = 0; i < 2500; i++) {
    log.append(
      parseEvent(line({ addInvoice: { id: `P${i % 17}:${i}`, ccy: 'CNY', num: randInt(rng, -999, 999) } }), ++lineno)
    );
  }
  // correct the very first invoice and undo an early one: O(1) each
  log.append(parseEvent(line({ correct: { refId: 'P0:0', newNum: 5 } }), ++lineno));
  log.append(parseEvent(line({ undo: { eventId: 'evt:2' } }), ++lineno));
  log.append(parseEvent(line({ undo: { eventId: 'evt:2501' } }), ++lineno)); // undo the correct
  assert.equal(log.stats.hashRecomputations, 0);
  assert.equal(log.effective.length, 2499);
  // head must match a from-scratch reference recomputation
  assert.equal(log.head, referenceHash(log.effective));
});

test('random op sequences keep head consistent with reference hash', () => {
  const rng = mulberry32(7);
  for (let trial = 0; trial < 30; trial++) {
    const log = new EventLog();
    let lineno = 0;
    let invoiceCount = 0;
    for (let step = 0; step < 60; step++) {
      const roll = rng();
      try {
        if (roll < 0.5) {
          log.append(parseEvent(line({ addInvoice: { id: `X:${invoiceCount++}`, ccy: 'CNY', num: randInt(rng, -50, 50) } }), ++lineno));
        } else if (roll < 0.7 && invoiceCount > 0) {
          log.append(parseEvent(line({ correct: { refId: `X:${randInt(rng, 0, invoiceCount - 1)}`, newNum: randInt(rng, -50, 50) } }), ++lineno));
        } else if (log.entries.length > 0) {
          const target = log.entries[randInt(rng, 0, log.entries.length - 1)];
          log.append(parseEvent(line({ undo: { eventId: target.eid } }), ++lineno));
        }
      } catch (e) {
        assert.ok(e instanceof CodedError && e.code === 'E_REF');
      }
    }
    assert.equal(log.head, referenceHash(log.effective), `trial ${trial}`);
  }
});
