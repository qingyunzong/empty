'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function runCli(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restate-'));
  const inPath = path.join(dir, 'input.json');
  const outPath = path.join(dir, 'output.json');
  fs.writeFileSync(inPath, JSON.stringify(input));
  const res = spawnSync(process.execPath, ['.', 'restate', inPath, outPath], {
    cwd: root,
    encoding: 'utf8',
  });
  const out = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;
  return { res, out };
}

const validInput = {
  items: [
    { id: 'A1', side: 'asset', restatement: true },
    { id: 'L1', side: 'liability' },
    { id: 'E1', side: 'equity' },
  ],
  periods: [
    { id: 'P1', status: 'closed' },
    { id: 'P2', status: 'open' },
  ],
  balances: { A1: { P1: 100, P2: 120 }, L1: { P1: 60, P2: 60 }, E1: { P1: 50, P2: 50 } },
  domain: { min: -50, max: 50, step: 10 },
  formulas: [
    { id: 'F_BS', lhs: [{ side: 'asset' }], rhs: [{ side: 'liability' }, { side: 'equity' }] },
    { id: 'F_IS', lhs: [{ item: 'A1' }], rhs: [{ item: 'E1', coef: 2 }, { const: 10 }] },
    { id: 'F_CF', lhs: [{ item: 'L1' }], rhs: [{ item: 'E1' }, { const: 10 }] },
  ],
  vouchers: [{ id: 'V1', layer: 'L1' }],
  layers: [{ id: 'L1', publish: 'ok' }],
};

test('CLI: node . restate writes selection, periods, layers, reversals, conflicts', () => {
  const { res, out } = runCli(validInput);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(out.status, 'SOLVED');
  assert.ok(Array.isArray(out.selection) && out.selection.length > 0);
  for (const e of out.selection) {
    assert.ok(e.voucher && e.item && e.period && typeof e.amount === 'number');
  }
  assert.ok(out.targetPeriods.includes('P1'));
  assert.deepEqual(out.periods, [
    { id: 'P1', status: 'closed' },
    { id: 'P2', status: 'open' },
  ]);
  assert.deepEqual(out.layers, [{ id: 'L1', status: 'PUBLISHED', reversal: 0 }]);
  assert.equal(out.reversalTotal, 0);
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.balanced, true);
});

test('CLI: referencing a nonexistent formula exits with code 1', () => {
  const { res, out } = runCli({ ...validInput, check: ['F_BS', 'NOPE'] });
  assert.equal(res.status, 1);
  assert.equal(out.status, 'ERROR');
  assert.equal(out.code, 'E_FORMULA');
});

test('CLI: an invalid period reference exits with code 1', () => {
  const bad = JSON.parse(JSON.stringify(validInput));
  bad.balances.A1.P9 = 5;
  const { res, out } = runCli(bad);
  assert.equal(res.status, 1);
  assert.equal(out.status, 'ERROR');
  assert.equal(out.code, 'E_PERIOD');
});

test('CLI: an invalid period status exits with code 1', () => {
  const bad = JSON.parse(JSON.stringify(validInput));
  bad.periods[0].status = 'locked';
  const { res, out } = runCli(bad);
  assert.equal(res.status, 1);
  assert.equal(out.code, 'E_PERIOD');
});
