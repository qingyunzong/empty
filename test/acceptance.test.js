import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDir, write, runCli, lcg } from './helpers.js';
import { sha256Hex } from '../src/hash.js';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/checker.js';
import { compile } from '../src/compiler.js';
import { dateToDays, daysToDate } from '../src/money.js';

function perRuleHashes(src, names) {
  const program = check(parse(tokenize(src)));
  const chunk = compile(program, src);
  const out = {};
  for (const name of names) {
    const unit = chunk.rules.find((r) => r.name === name) || chunk.globals.find((g) => g.name === name);
    assert.ok(unit, `no rule/global named ${name}`);
    out[name] = unit.hash;
  }
  return out;
}

// ---------- Acceptance 1: fee / tax / net rules run, certificates replay ----------

const RULES_V1 = `
# fee: 0.15% of amount, minimum 0.50; tax: 6% VAT on the fee; net: amount - fee - tax
param fee_rate: rate = 0.0015r
param vat_rate: rate = 0.06r

let min_fee: money = 0.50

rule fee(amount: money, day: date) -> money {
  let raw: money = amount * fee_rate
  if raw < min_fee { min_fee } else { raw }
}

rule tax(amount: money, day: date) -> money {
  fee(amount, day) * vat_rate
}

rule net(amount: money, day: date) -> money {
  amount - fee(amount, day) - tax(amount, day)
}
`;

test('acceptance 1: fee/tax/net rules run and the certificate replays', async () => {
  const dir = makeDir();
  const rules = write(dir, 'rules.stl', RULES_V1);
  const input = write(dir, 'input.json', JSON.stringify({
    rulesHash: sha256Hex(RULES_V1),
    flows: [
      { id: 'a', amount: '1000.00', date: '2024-01-15' },
      { id: 'b', amount: '10.00', date: '2024-03-01' },
    ],
  }));
  const cert = `${dir}/cert.json`;
  const run = await runCli(['run', rules, input, '--cert', cert]);
  assert.equal(run.status, 0, run.stderr);
  const results = JSON.parse(run.stdout).results;
  assert.deepEqual(results, [
    { id: 'a', fee: '1.50', tax: '0.09', net: '998.41' },
    { id: 'b', fee: '0.50', tax: '0.03', net: '9.47' },
  ]);

  const certJson = JSON.parse(readFileSync(cert, 'utf8'));
  for (const name of ['fee', 'tax', 'net']) {
    assert.ok(certJson.rulesHash[name], `cert rulesHash covers ${name}`);
    assert.ok(certJson.bytecodeHash[name], `cert bytecodeHash covers ${name}`);
  }
  assert.ok(certJson.inputHash.startsWith('sha256:'));
  assert.ok(certJson.traceSummary.steps > 0);

  const verify = await runCli(['verify', rules, input, '--cert', cert]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);
});

// ---------- Acceptance 2: mandated error cases ----------

test('acceptance 2: 1.005, negative rate, duplicate let, unbound variable', async () => {
  const cases = [
    ['let x: money = 1.005\n', 'E_LEX'],
    ['param vat_rate: rate = -0.06r\n', 'E_TYPE'],
    ['let x: money = 1.00\nlet x: money = 2.00\n', 'E_SCOPE'],
    ['rule f(amount: money, day: date) -> money { amount + missing }\n', 'E_SCOPE'],
  ];
  const dir = makeDir();
  const input = write(dir, 'input.json', JSON.stringify({ rulesHash: 'sha256:unused', flows: [] }));
  for (const [src, code] of cases) {
    const rules = write(dir, 'bad.stl', src);
    const res = await runCli(['run', rules, input, '--cert', `${dir}/c.json`]);
    assert.notEqual(res.status, 0, `expected non-zero exit for ${code}`);
    const err = JSON.parse(res.stderr).error;
    assert.equal(err.code, code, `expected ${code}, got ${JSON.stringify(err)}`);
    assert.equal(typeof err.line, 'number');
    assert.equal(typeof err.col, 'number');
  }
});

// ---------- Acceptance 3: 100 random flows vs an independent reference ----------

// Independent reference implementation (separate from src/money.js): plain
// Number arithmetic, round half-up on (cents * micro) / 1e6.
function reference(amountStr) {
  const cents = Number(amountStr.replace('.', ''));
  const fee = Math.floor((cents * 1500 + 500000) / 1000000);
  const tax = Math.floor((fee * 60000 + 500000) / 1000000);
  const net = cents - fee - tax;
  const fmt = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
  return { fee: fmt(fee), tax: fmt(tax), net: fmt(net) };
}

test('acceptance 3: 100 random flows match the independent rounding reference', async () => {
  const dir = makeDir();
  const rules = write(dir, 'rules.stl', RULES_V1.replace('let min_fee: money = 0.50', 'let min_fee: money = 0.00'));
  const src = readFileSync(rules, 'utf8');
  const rand = lcg(20240115);
  const base = dateToDays(2023, 1, 1);
  const flows = [];
  for (let i = 0; i < 100; i++) {
    const cents = 100 + Math.floor(rand() * 5000000);
    flows.push({
      id: `f-${String(i).padStart(3, '0')}`,
      amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`,
      date: daysToDate(base + Math.floor(rand() * 730)),
    });
  }
  const input = write(dir, 'input.json', JSON.stringify({ rulesHash: sha256Hex(src), flows }));
  const cert = `${dir}/cert.json`;
  const run = await runCli(['run', rules, input, '--cert', cert]);
  assert.equal(run.status, 0, run.stderr);
  const results = JSON.parse(run.stdout).results;
  assert.equal(results.length, 100);
  for (let i = 0; i < 100; i++) {
    const expected = reference(flows[i].amount);
    assert.deepEqual(
      { fee: results[i].fee, tax: results[i].tax, net: results[i].net },
      expected,
      `flow ${flows[i].id} amount ${flows[i].amount}`,
    );
  }
  const verify = await runCli(['verify', rules, input, '--cert', cert]);
  assert.equal(verify.status, 0, verify.stderr);
});

// ---------- Acceptance 4: changing one rule only affects its own batches ----------

const PLAN_RULES_V1 = `
param std_rate: rate = 0.001r
param vip_rate: rate = 0.0005r

rule fee_std(amount: money, day: date) -> money { amount * std_rate }
rule tax_std(amount: money, day: date) -> money { fee_std(amount, day) * 0.06r }
rule net_std(amount: money, day: date) -> money { amount - fee_std(amount, day) - tax_std(amount, day) }

rule fee_vip(amount: money, day: date) -> money { amount * vip_rate }
rule tax_vip(amount: money, day: date) -> money { fee_vip(amount, day) * 0.06r }
rule net_vip(amount: money, day: date) -> money { amount - fee_vip(amount, day) - tax_vip(amount, day) }
`;
const PLAN_RULES_V2 = PLAN_RULES_V1.replace('vip_rate: rate = 0.0005r', 'vip_rate: rate = 0.0008r');

const STD_NAMES = ['fee_std', 'tax_std', 'net_std', 'std_rate'];
const VIP_NAMES = ['fee_vip', 'tax_vip', 'net_vip', 'vip_rate'];

test('acceptance 4: modifying one rule only changes the certificates of affected batches', async () => {
  const dir = makeDir();
  const rulesV1 = write(dir, 'rules-v1.stl', PLAN_RULES_V1);
  const rulesV2 = write(dir, 'rules-v2.stl', PLAN_RULES_V2);

  const batchA = write(dir, 'batchA.json', JSON.stringify({
    rulesHash: perRuleHashes(PLAN_RULES_V1, STD_NAMES),
    flows: [
      { id: 'a1', amount: '2000.00', date: '2024-01-10', plan: 'std' },
      { id: 'a2', amount: '3000.00', date: '2024-01-11', plan: 'std' },
    ],
  }));
  const batchB = write(dir, 'batchB.json', JSON.stringify({
    rulesHash: perRuleHashes(PLAN_RULES_V1, VIP_NAMES),
    flows: [
      { id: 'b1', amount: '2000.00', date: '2024-01-10', plan: 'vip' },
      { id: 'b2', amount: '4000.00', date: '2024-01-12', plan: 'vip' },
    ],
  }));

  const certA1 = `${dir}/certA1.json`;
  const certB1 = `${dir}/certB1.json`;
  assert.equal((await runCli(['run', rulesV1, batchA, '--cert', certA1])).status, 0);
  assert.equal((await runCli(['run', rulesV1, batchB, '--cert', certB1])).status, 0);

  // After the vip rule change, batch A still runs against its pinned rules
  // (its input file is untouched) and produces an identical certificate.
  const certA2 = `${dir}/certA2.json`;
  const rerunA = await runCli(['run', rulesV2, batchA, '--cert', certA2]);
  assert.equal(rerunA.status, 0, rerunA.stderr);
  assert.deepEqual(JSON.parse(readFileSync(certA2, 'utf8')), JSON.parse(readFileSync(certA1, 'utf8')));

  // Batch B is re-pinned to the new rule hashes; its certificate changes.
  const batchB2 = write(dir, 'batchB2.json', JSON.stringify({
    rulesHash: perRuleHashes(PLAN_RULES_V2, VIP_NAMES),
    flows: [
      { id: 'b1', amount: '2000.00', date: '2024-01-10', plan: 'vip' },
      { id: 'b2', amount: '4000.00', date: '2024-01-12', plan: 'vip' },
    ],
  }));
  const certB2 = `${dir}/certB2.json`;
  assert.equal((await runCli(['run', rulesV2, batchB2, '--cert', certB2])).status, 0);
  assert.notDeepEqual(JSON.parse(readFileSync(certB2, 'utf8')), JSON.parse(readFileSync(certB1, 'utf8')));

  // And the affected batch's new certificate still replays.
  const verify = await runCli(['verify', rulesV2, batchB2, '--cert', certB2]);
  assert.equal(verify.status, 0, verify.stderr);
});
