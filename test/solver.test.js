'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalize, evaluateAll } = require('../lib/model');
const { solve } = require('../lib/solver');
const { enumerateSat } = require('../lib/brute');

// Three-statement fixture: balance sheet, income, cash-flow identities over
// 3 items and 2 periods (P1 closed, P2 open). Only A1 may be restated in P1.
function threeStatementInput(overrides = {}) {
  return {
    items: [
      { id: 'A1', side: 'asset', restatement: true },
      { id: 'L1', side: 'liability' },
      { id: 'E1', side: 'equity' },
    ],
    periods: [
      { id: 'P1', status: 'closed' },
      { id: 'P2', status: 'open' },
    ],
    balances: {
      A1: { P1: 100, P2: 120 },
      L1: { P1: 60, P2: 60 },
      E1: { P1: 50, P2: 50 },
    },
    domain: { min: -50, max: 50, step: 10 },
    formulas: [
      { id: 'F_BS', lhs: [{ side: 'asset' }], rhs: [{ side: 'liability' }, { side: 'equity' }] },
      { id: 'F_IS', lhs: [{ item: 'A1' }], rhs: [{ item: 'E1', coef: 2 }, { const: 10 }] },
      { id: 'F_CF', lhs: [{ item: 'L1' }], rhs: [{ item: 'E1' }, { const: 10 }] },
    ],
    vouchers: [{ id: 'V1', layer: 'L1' }],
    layers: [{ id: 'L1', publish: 'ok' }],
    ...overrides,
  };
}

function voucherNatureSum(model, entries) {
  const nature = new Map(model.items.map((i) => [i.id, i.side]));
  const nat = { asset: 1, expense: 1, liability: -1, equity: -1, revenue: -1 };
  const sums = {};
  for (const e of entries) {
    sums[e.voucher] = (sums[e.voucher] || 0) + e.amount * (nat[nature.get(e.item)] ?? 1);
  }
  return sums;
}

test('acceptance 1: all three statements balance after correction', () => {
  const model = normalize(threeStatementInput());
  const r = solve(model);
  assert.equal(r.status, 'SOLVED');
  const residuals = evaluateAll(model, r.entries, model.check);
  assert.equal(residuals.length, 6); // 3 formulas x 2 periods
  for (const x of residuals) assert.equal(x.residual, 0, `${x.formula}@${x.period}`);
  assert.deepEqual(r.conflicts, []);
  // debit/credit pairing inside the voucher
  for (const sum of Object.values(voucherNatureSum(model, r.entries))) {
    assert.equal(sum, 0);
  }
});

test('acceptance 2: closed period is corrected only via restatement items', () => {
  const model = normalize(threeStatementInput());
  const r = solve(model);
  assert.equal(r.status, 'SOLVED');
  const closed = r.entries.filter((e) => e.period === 'P1');
  assert.ok(closed.length > 0, 'expected a restatement entry in the closed period');
  for (const e of closed) {
    const item = model.items.find((i) => i.id === e.item);
    assert.equal(item.restatement, true, `closed-period entry on ${e.item}`);
  }
});

test('closed period rejects entries on non-restatement items', () => {
  const model = normalize(threeStatementInput());
  const bad = [{ voucher: 'V1', item: 'L1', period: 'P1', amount: -10 }];
  const vars = require('../lib/solver').buildVars(model);
  const v = vars.find((x) => x.item === 'L1' && x.period === 'P1');
  assert.deepEqual(v.domain, [0]);
  assert.ok(bad.length === 1);
});

test('acceptance 4: infeasible correction is UNSAT with a minimal conflict core', () => {
  const input = threeStatementInput();
  input.items[0].restatement = false; // closed P1 can no longer be touched
  const model = normalize(input);
  const r = solve(model);
  assert.equal(r.status, 'UNSAT');
  assert.ok(Array.isArray(r.conflicts));
  assert.equal(r.conflicts.length, 1);
  assert.ok(['F_BS', 'F_IS'].includes(r.conflicts[0]));
});

test('exhausted backtracking budget yields PENDING, not UNSAT', () => {
  const model = normalize(threeStatementInput({ budget: 1 }));
  const r = solve(model);
  assert.equal(r.status, 'PENDING');
  assert.equal(r.conflicts, null);
});

test('enumeration cross-check: solver agrees with brute force (<=3 items, 2 periods)', () => {
  const cases = [
    threeStatementInput(), // SAT
    threeStatementInput({ budget: 500000 }),
    (() => {
      const i = threeStatementInput();
      i.items[0].restatement = false; // UNSAT
      return i;
    })(),
    // 2-item SAT case: r1 = 10 fixed by A1(P1) -= 10, r2 = -10 offset in P2
    {
      items: [
        { id: 'A1', side: 'asset', restatement: true },
        { id: 'E1', side: 'equity' },
      ],
      periods: [
        { id: 'P1', status: 'closed' },
        { id: 'P2', status: 'open' },
      ],
      balances: { A1: { P1: 100, P2: 40 }, E1: { P1: 90, P2: 50 } },
      domain: { values: [-10, 10] },
      formulas: [
        { id: 'F1', lhs: [{ side: 'asset' }], rhs: [{ side: 'equity' }] },
      ],
      vouchers: [{ id: 'V1', layer: 'L1' }],
      layers: [{ id: 'L1' }],
    },
    // 2-item UNSAT case: P2 residual 0 cannot absorb the P1 offset
    {
      items: [
        { id: 'A1', side: 'asset', restatement: true },
        { id: 'E1', side: 'equity' },
      ],
      periods: [
        { id: 'P1', status: 'closed' },
        { id: 'P2', status: 'open' },
      ],
      balances: { A1: { P1: 100, P2: 50 }, E1: { P1: 90, P2: 50 } },
      domain: { values: [-10, 10] },
      formulas: [
        { id: 'F1', lhs: [{ side: 'asset' }], rhs: [{ side: 'equity' }] },
      ],
      vouchers: [{ id: 'V1', layer: 'L1' }],
      layers: [{ id: 'L1' }],
    },
  ];
  for (const [idx, input] of cases.entries()) {
    const model = normalize(input);
    const r = solve(model);
    const brute = enumerateSat(model, model.check);
    assert.equal(
      r.status === 'SOLVED',
      brute.sat,
      `case ${idx}: solver=${r.status} brute=${brute.sat ? 'SAT' : 'UNSAT'}`
    );
    if (r.status === 'SOLVED') {
      const residuals = evaluateAll(model, r.entries, model.check);
      for (const x of residuals) assert.equal(x.residual, 0);
    }
  }
});
