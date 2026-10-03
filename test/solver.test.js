'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { solve, InputError } = require('../lib/solver');
const { enumerateAssignments } = require('../lib/enumerate');
const { run } = require('../index');

const accounts = {
  '1001': { group: 'cash' },
  '6001': { group: 'revenue' },
  '2202': { group: 'payable' },
};
const reviewers = [
  { id: 'R1', groups: ['cash', 'payable'] },
  { id: 'R2', groups: ['revenue'] },
  { id: 'R3', groups: ['cash', 'revenue', 'payable'] },
];
const periods = [
  { id: '2026-09', status: 'open' },
  { id: '2026-10', status: 'open' },
];
const layers = [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }];

function baseInput(overrides = {}) {
  return {
    entries: [
      { id: 'E1', account: '1001', direction: 'debit', amount: 100 },
      { id: 'E2', account: '6001', direction: 'credit', amount: 100 },
    ],
    accounts,
    reviewers,
    periods,
    originalPeriod: '2026-09',
    adjustmentPeriod: '2026-10',
    layers,
    revocations: [],
    ...overrides,
  };
}

test('acceptance 1: balanced and permission-feasible -> SOLVED', () => {
  const r = solve(baseInput());
  assert.equal(r.status, 'SOLVED');
  assert.equal(r.voucher.debitTotal, r.voucher.creditTotal);
  assert.equal(r.voucher.period, '2026-09');
  assert.equal(r.voucher.rerouted, false);
  const byId = Object.fromEntries(r.voucher.entries.map((e) => [e.id, e]));
  assert.ok(['R1', 'R3'].includes(byId.E1.reviewer)); // cash group
  assert.ok(['R2', 'R3'].includes(byId.E2.reviewer)); // revenue group
  assert.deepEqual(r.trail.map((t) => t.status), ['approved', 'approved', 'approved']);
  assert.equal(r.occupied, 300); // 3 layers x 100
  assert.equal(r.released, 0);
});

test('acceptance 2: closed period reroutes to adjustment period', () => {
  const r = solve(baseInput({
    periods: [
      { id: '2026-09', status: 'closed' },
      { id: '2026-10', status: 'open' },
    ],
  }));
  assert.equal(r.status, 'SOLVED');
  assert.equal(r.voucher.period, '2026-10');
  assert.equal(r.voucher.rerouted, true);
});

test('closed period with closed adjustment period -> UNSAT with conflict core', () => {
  const r = solve(baseInput({
    periods: [
      { id: '2026-09', status: 'closed' },
      { id: '2026-10', status: 'closed' },
    ],
  }));
  assert.equal(r.status, 'UNSAT');
  assert.ok(r.conflictCore.some((c) => c.includes('no open posting period')));
});

test('acceptance 3: rejection at L2 releases all lower-layer reservations', () => {
  const r = solve(baseInput({ revocations: [{ layer: 'L2' }] }));
  assert.equal(r.status, 'SOLVED');
  assert.deepEqual(r.trail, [
    { layer: 'L1', status: 'approved', occupied: 100 },
    { layer: 'L2', status: 'rejected' },
    { layer: 'L3', status: 'released', released: 100 },
  ]);
  assert.equal(r.occupied, 100);
  assert.equal(r.released, 100);
});

test('acceptance 4a: unbalanced voucher -> UNSAT proven by enumeration', () => {
  const r = solve(baseInput({
    entries: [
      { id: 'E1', account: '1001', direction: 'debit', amount: 100 },
      { id: 'E2', account: '6001', direction: 'credit', amount: 60 },
    ],
  }));
  assert.equal(r.status, 'UNSAT');
  assert.ok(r.conflictCore.some((c) => c.includes('unbalanced')));
  assert.equal(r.proof.solutions, 0);
});

test('acceptance 4b: no authorized reviewer -> UNSAT proven by enumeration', () => {
  const r = solve(baseInput({
    entries: [
      { id: 'E1', account: '1001', direction: 'debit', amount: 100 },
      { id: 'E2', account: '6001', direction: 'credit', amount: 100 },
    ],
    reviewers: [{ id: 'R1', groups: ['cash'] }], // nobody can take revenue
  }));
  assert.equal(r.status, 'UNSAT');
  assert.ok(r.conflictCore.some((c) => c.includes('no reviewer authorized')));
  assert.equal(r.proof.solutions, 0);
});

test('acceptance 4c: capacity-infeasible -> UNSAT proven by enumeration', () => {
  const r = solve(baseInput({
    entries: [
      { id: 'E1', account: '1001', direction: 'debit', amount: 100 },
      { id: 'E2', account: '2202', direction: 'debit', amount: 50 },
      { id: 'E3', account: '6001', direction: 'credit', amount: 150 },
    ],
    reviewers: [
      { id: 'R1', groups: ['cash', 'payable'], capacity: 120 },
      { id: 'R2', groups: ['revenue'] },
    ],
  }));
  assert.equal(r.status, 'UNSAT');
  assert.equal(r.proof.solutions, 0);
  assert.ok(r.proof.enumerated > 0);
});

test('budget exhausted before determination -> PENDING, never UNSAT', () => {
  const entries = [];
  for (let i = 0; i < 8; i += 1) {
    entries.push({ id: `D${i}`, account: '1001', direction: 'debit', amount: 10 });
    entries.push({ id: `C${i}`, account: '6001', direction: 'credit', amount: 10 });
  }
  const r = solve(baseInput({ entries, budget: 5 }));
  assert.equal(r.status, 'PENDING');
  assert.ok(r.pending.length > 0);
  assert.ok(r.pending.every((p) => p.remainingDomain.length > 0));
  assert.notEqual(r.status, 'UNSAT');
});

test('enumeration cross-check: solver agrees with brute force (<=3 reviewers, 2 periods)', () => {
  const fixtures = [
    baseInput(),
    baseInput({ reviewers: reviewers.map((r) => ({ ...r, capacity: 100 })) }),
    baseInput({ reviewers: reviewers.map((r) => ({ ...r, capacity: 150 })) }),
    baseInput({
      entries: [
        { id: 'E1', account: '1001', direction: 'debit', amount: 80 },
        { id: 'E2', account: '2202', direction: 'debit', amount: 20 },
        { id: 'E3', account: '6001', direction: 'credit', amount: 100 },
      ],
    }),
    baseInput({
      entries: [
        { id: 'E1', account: '1001', direction: 'debit', amount: 100 },
        { id: 'E2', account: '6001', direction: 'credit', amount: 100 },
      ],
      reviewers: reviewers.map((r) => ({ ...r, capacity: 90 })),
    }),
  ];
  for (const fx of fixtures) {
    const r = solve(fx);
    const entries = fx.entries.map((e, i) => ({ id: e.id || `E${i + 1}`, ...e }));
    const domains = entries.map((e) =>
      fx.reviewers.filter((rv) => rv.groups.includes(fx.accounts[e.account].group)).map((rv) => rv.id));
    const brute = enumerateAssignments(entries, domains, fx.reviewers);
    if (brute.solutions > 0) assert.equal(r.status, 'SOLVED');
    else assert.equal(r.status, 'UNSAT');
  }
});

test('unknown account -> InputError UNKNOWN_ACCOUNT', () => {
  assert.throws(
    () => solve(baseInput({ entries: [{ id: 'E1', account: '9999', direction: 'debit', amount: 1 }] })),
    (e) => e instanceof InputError && e.code === 'UNKNOWN_ACCOUNT',
  );
});

test('revocation of non-existent layer -> InputError UNKNOWN_LAYER', () => {
  assert.throws(
    () => solve(baseInput({ revocations: [{ layer: 'L9' }] })),
    (e) => e instanceof InputError && e.code === 'UNKNOWN_LAYER',
  );
});

function runCli(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const inPath = path.join(dir, 'input.json');
  const outPath = path.join(dir, 'output.json');
  fs.writeFileSync(inPath, JSON.stringify(input));
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  };
  const code = run(['audit', inPath, outPath], io);
  const output = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;
  return { res: { status: code, stdout, stderr }, output };
}

test('CLI: node . audit writes SOLVED output', () => {
  const { res, output } = runCli(baseInput());
  assert.equal(res.status, 0);
  assert.equal(output.status, 'SOLVED');
  assert.ok(output.voucher.id.startsWith('ADJ-'));
});

test('CLI: unknown account exits with code 1', () => {
  const { res } = runCli(baseInput({
    entries: [{ id: 'E1', account: '9999', direction: 'debit', amount: 1 }],
  }));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /UNKNOWN_ACCOUNT/);
});

test('CLI: revocation of non-existent layer exits with code 1', () => {
  const { res } = runCli(baseInput({ revocations: [{ layer: 'L9' }] }));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /UNKNOWN_LAYER/);
});
