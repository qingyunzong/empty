'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCertificate } = require('../src/cli');

const RULES_V1 = `
let fee_rate: rate = 0.0015;
let vat_rate: rate = 0.06;
rule fee(amount: money, day: date) -> money {
  return round(amount * fee_rate);
}
rule tax(amount: money, day: date) -> money {
  return round(fee(amount, day) * vat_rate);
}
rule net(amount: money, day: date) -> money {
  return amount - fee(amount, day) - tax(amount, day);
}
`;

// Only the tax rule changes (extra let, same semantics).
const RULES_V2 = `
let fee_rate: rate = 0.0015;
let vat_rate: rate = 0.06;
rule fee(amount: money, day: date) -> money {
  return round(amount * fee_rate);
}
rule tax(amount: money, day: date) -> money {
  let f: money = fee(amount, day);
  return round(f * vat_rate);
}
rule net(amount: money, day: date) -> money {
  return amount - fee(amount, day) - tax(amount, day);
}
`;

test('changing one rule only changes that rule entry in the certificate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cert-'));
  const r1 = path.join(dir, 'v1.stl');
  const r2 = path.join(dir, 'v2.stl');
  const input = path.join(dir, 'input.json');
  fs.writeFileSync(r1, RULES_V1);
  fs.writeFileSync(r2, RULES_V2);
  fs.writeFileSync(input, JSON.stringify({
    flows: [{ id: 'a', amount: '100.00', date: '2026-10-01' }],
  }));

  const c1 = buildCertificate(r1, input);
  const c2 = buildCertificate(r2, input);

  // overall provenance hashes change
  assert.notEqual(c1.rules_hash, c2.rules_hash);
  assert.notEqual(c1.bytecode_hash, c2.bytecode_hash);
  // only the affected rule's bytecode hash changes
  assert.notEqual(c1.rule_hashes.tax, c2.rule_hashes.tax);
  assert.equal(c1.rule_hashes.fee, c2.rule_hashes.fee);
  assert.equal(c1.rule_hashes.net, c2.rule_hashes.net);
  // input hash and results are stable
  assert.equal(c1.input_hash, c2.input_hash);
  assert.deepEqual(c1.results, c2.results);
});
