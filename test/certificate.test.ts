import test from 'node:test';
import assert from 'node:assert/strict';
import { Certificate, parse, verifyCertificate } from '../src/index';

const grammar = {
  start: 'S',
  rules: [
    { id: 1, lhs: 'S', rhs: ['S', '+', 'S'], cost: 1 },
    { id: 2, lhs: 'S', rhs: ['num'], cost: 2 },
  ],
};
const sequence = ['num', '+', 'num'];

function goodCertificate(): Certificate {
  const res = parse(grammar, sequence);
  if (res.status === 'infeasible') throw new Error('expected a parse');
  const check = verifyCertificate(grammar, res.certificate);
  assert.deepEqual(check, { ok: true });
  return res.certificate;
}

test('a genuine certificate verifies', () => {
  const cert = goodCertificate();
  assert.equal(cert.cost, 5); // 2 + 1 + 2
  assert.deepEqual(cert.ruleIds, [1, 2, 2]);
  assert.deepEqual(verifyCertificate(grammar, cert), { ok: true });
});

test('tampered cost is rejected', () => {
  const cert = { ...goodCertificate(), cost: 4 };
  const res = verifyCertificate(grammar, cert);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /cost/);
});

test('tampered rule-id sequence is rejected', () => {
  const cert = { ...goodCertificate(), ruleIds: [2, 1, 2] };
  const res = verifyCertificate(grammar, cert);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /ruleIds|preorder/);
});

test('tampered tree (wrong rule at a node) is rejected', () => {
  const good = goodCertificate();
  const cert: Certificate = {
    ...good,
    tree: { ...good.tree, ruleId: 2 }, // root now claims the 'num' rule
  };
  const res = verifyCertificate(grammar, cert);
  assert.equal(res.ok, false);
});

test('tampered sequence is rejected', () => {
  const cert = { ...goodCertificate(), sequence: ['num', '+', '+'] };
  const res = verifyCertificate(grammar, cert);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /yield/);
});

test('unknown rule id is rejected', () => {
  const good = goodCertificate();
  const cert: Certificate = {
    ...good,
    tree: { ...good.tree, ruleId: 99 },
    ruleIds: [99, 2, 2],
  };
  const res = verifyCertificate(grammar, cert);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /unknown rule id/);
});

test('certificate from another start symbol is rejected', () => {
  const cert = { ...goodCertificate(), start: 'X' };
  const res = verifyCertificate(grammar, cert);
  assert.equal(res.ok, false);
});
