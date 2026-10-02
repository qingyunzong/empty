import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/engine.js';
import { verifyCertificate } from '../src/verify.js';

const CONFLICT_LINES = [
  '{"type":"setRate","eid":"r1","pair":"USD/CNY","num":7,"den":1}',
  '{"type":"setRate","eid":"r2","pair":"CNY/EUR","num":1,"den":8}',
  '{"type":"setRate","eid":"r3","pair":"USD/EUR","num":9,"den":10}',
  '{"type":"addInvoice","eid":"i1","id":"A","ccy":"USD","num":100,"den":1}',
];
const EVENTS_TEXT = `${CONFLICT_LINES.join('\n')}\n`;

function makeCert(extraLines = []) {
  const l = new Ledger();
  [...CONFLICT_LINES, ...extraLines].forEach((s, i) => l.applyLine(s, i + 1));
  const r = l.settle({ base: 'CNY' });
  assert.equal(r.status, 'infeasible');
  return r.certificate;
}

test('acceptance 2: certificate is independently verified', () => {
  const cert = makeCert();
  const r = verifyCertificate(EVENTS_TEXT, cert);
  assert.equal(r.valid, true);
  assert.ok(r.checks.every((c) => c.ok));
});

test('tampered product is rejected', () => {
  const cert = { ...makeCert(), product: '1' };
  const r = verifyCertificate(EVENTS_TEXT, cert);
  assert.equal(r.valid, false);
});

test('certificate with a removed step is rejected', () => {
  const cert = makeCert();
  cert.steps = cert.steps.slice(1);
  const r = verifyCertificate(EVENTS_TEXT, cert);
  assert.equal(r.valid, false);
});

test('certificate bound to a different history is rejected', () => {
  const cert = makeCert();
  const modified = `${CONFLICT_LINES.join('\n')}\n{"type":"addInvoice","eid":"i9","id":"Z","ccy":"USD","num":1,"den":1}\n`;
  const r = verifyCertificate(modified, cert);
  assert.equal(r.valid, false);
  assert.ok(r.checks.some((c) => c.name === 'history-hash' && !c.ok));
});

test('certificate referencing a voided rate is rejected', () => {
  const cert = makeCert();
  const withUndo = `${EVENTS_TEXT}{"type":"undo","eid":"u1","eventId":"r3"}\n`;
  const r = verifyCertificate(withUndo, cert);
  assert.equal(r.valid, false);
});
