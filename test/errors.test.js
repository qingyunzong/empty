import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/engine.js';
import { LedgerError } from '../src/events.js';

function expectCode(lines, code) {
  const l = new Ledger();
  assert.throws(
    () => lines.forEach((s, i) => l.applyLine(s, i + 1)),
    (e) => e instanceof LedgerError && e.code === code
  );
}

test('E_PARSE on malformed JSON and bad shapes', () => {
  expectCode(['not json'], 'E_PARSE');
  expectCode(['{"type":"nope"}'], 'E_PARSE');
  expectCode(['{"type":"addInvoice","id":"A","ccy":"USD","num":1,"den":0}'], 'E_PARSE');
  expectCode(['{"type":"addInvoice","id":"A","ccy":"USD","num":1.5,"den":1}'], 'E_PARSE');
  expectCode(['{"type":"setRate","pair":"USD","num":1,"den":1}'], 'E_PARSE');
  expectCode(['{"type":"setRate","pair":"USD/CNY","num":-7,"den":1}'], 'E_PARSE');
  expectCode(['{"type":"setRate","pair":"USD/USD","num":1,"den":1}'], 'E_PARSE');
  expectCode(
    ['{"type":"addInvoice","eid":"x","id":"A","ccy":"USD","num":1,"den":1}', '{"type":"addInvoice","eid":"x","id":"B","ccy":"USD","num":1,"den":1}'],
    'E_PARSE'
  );
});

test('E_PARSE carries the line number', () => {
  const l = new Ledger();
  try {
    l.applyLine('{"type":"addInvoice","id":"A","ccy":"USD","num":1,"den":1}', 1);
    l.applyLine('{bad', 2);
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.code, 'E_PARSE');
    assert.equal(e.line, 2);
  }
});

test('E_REF on unknown or invalid references', () => {
  expectCode(['{"type":"undo","eventId":"ghost"}'], 'E_REF');
  expectCode(['{"type":"correct","refId":"ghost","newNum":1,"newDen":1}'], 'E_REF');
  expectCode(
    ['{"type":"undo","eid":"u1","eventId":"u2"}', '{"type":"undo","eid":"u2","eventId":"u1"}'],
    'E_REF'
  );
  expectCode(
    [
      '{"type":"addInvoice","eid":"i1","id":"A","ccy":"USD","num":1,"den":1}',
      '{"type":"undo","eid":"u1","eventId":"i1"}',
      '{"type":"correct","eid":"c1","refId":"i1","newNum":2,"newDen":1}',
    ],
    'E_REF'
  );
  expectCode(
    [
      '{"type":"addInvoice","eid":"i1","id":"A","ccy":"USD","num":1,"den":1}',
      '{"type":"undo","eid":"u1","eventId":"i1"}',
      '{"type":"correct","eid":"c1","refId":"u1","newNum":2,"newDen":1}',
    ],
    'E_REF'
  );
});
