'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { solve, InputError } = require('../lib/solver');

const repoRoot = path.join(__dirname, '..');

function baseInput(overrides = {}) {
  return {
    voucherNo: 'ADJ-001',
    entries: [
      { account: '1001', direction: 'debit', amount: 500 },
      { account: '6001', direction: 'credit', amount: 500 },
    ],
    accountGroups: { '1001': 'asset', '6001': 'revenue' },
    reviewers: [
      { id: 'R1', groups: ['asset', 'revenue'] },
      { id: 'R2', groups: ['asset', 'revenue'] },
      { id: 'R3', groups: ['asset'] },
    ],
    periods: [
      { id: '2026-09', status: 'closed', adjustmentPeriod: '2026-10' },
      { id: '2026-10', status: 'open' },
    ],
    requestedPeriod: '2026-10',
    approvalLayers: [{ id: 'L1' }, { id: 'L2' }],
    revocations: [],
    budget: 100,
    ...overrides,
  };
}

function bruteForce(input) {
  let debit = 0;
  let credit = 0;
  for (const entry of input.entries) {
    if (entry.direction === 'debit') debit += entry.amount;
    else credit += entry.amount;
  }
  if (debit !== credit) return { feasible: false, combos: 0 };

  const periodMap = new Map(input.periods.map((period) => [period.id, period]));
  const requested = periodMap.get(input.requestedPeriod);
  const periodChoices = [];
  if (requested.status === 'open') {
    periodChoices.push(requested.id);
  } else {
    const adjustment = requested.adjustmentPeriod
      ? periodMap.get(requested.adjustmentPeriod)
      : undefined;
    if (adjustment && adjustment.status === 'open') periodChoices.push(adjustment.id);
  }
  if (periodChoices.length === 0) return { feasible: false, combos: 0 };

  const required = [...new Set(input.entries.map((entry) => input.accountGroups[entry.account]))];
  const candidates = input.reviewers
    .filter((reviewer) => required.every((group) => reviewer.groups.includes(group)))
    .map((reviewer) => reviewer.id);

  let combos = 0;
  const used = new Set();
  function walk(index) {
    if (index === input.approvalLayers.length) {
      combos += periodChoices.length;
      return;
    }
    for (const candidate of candidates) {
      if (used.has(candidate)) continue;
      used.add(candidate);
      walk(index + 1);
      used.delete(candidate);
    }
  }
  walk(0);
  return { feasible: combos > 0, combos };
}

test('acceptance 1: balanced entries with feasible permissions are approved', () => {
  const result = solve(baseInput());
  assert.equal(result.status, 'APPROVED');
  assert.equal(result.voucherNo, 'ADJ-001');
  assert.equal(result.period, '2026-10');
  assert.equal(result.rerouted, false);
  assert.equal(result.occupied.length, 2);
  assert.ok(result.occupied.every((slot) => slot.amount === 500));
  assert.equal(result.released.length, 0);
  const assigned = result.assignment.map((slot) => slot.reviewer);
  assert.ok(!assigned.includes('R3'), 'unauthorized reviewer R3 must not be assigned');
  assert.equal(new Set(assigned).size, assigned.length, 'reviewers are distinct per layer');
  assert.ok(result.approvalTrail.every((step) => step.decision === 'approved'));
});

test('acceptance 2: closed requested period reroutes to adjustment period', () => {
  const result = solve(baseInput({ requestedPeriod: '2026-09' }));
  assert.equal(result.status, 'APPROVED');
  assert.equal(result.requestedPeriod, '2026-09');
  assert.equal(result.period, '2026-10');
  assert.equal(result.rerouted, true);
});

test('acceptance 2b: closed period without open adjustment period is UNSAT', () => {
  const result = solve(
    baseInput({
      periods: [
        { id: '2026-09', status: 'closed', adjustmentPeriod: '2026-10' },
        { id: '2026-10', status: 'closed' },
      ],
      requestedPeriod: '2026-09',
    }),
  );
  assert.equal(result.status, 'UNSAT');
  assert.ok(result.conflictCore.some((line) => line.startsWith('period:')));
});

test('acceptance 3: rejection releases the rejected layer and all lower layers', () => {
  const result = solve(
    baseInput({
      reviewers: [
        { id: 'R1', groups: ['asset', 'revenue'] },
        { id: 'R2', groups: ['asset', 'revenue'] },
        { id: 'R3', groups: ['asset', 'revenue'] },
      ],
      approvalLayers: [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }],
      revocations: ['L2'],
    }),
  );
  assert.equal(result.status, 'REJECTED');
  assert.deepEqual(
    result.approvalTrail.map((step) => step.decision),
    ['approved', 'rejected', 'released'],
  );
  assert.deepEqual(
    result.occupied.map((slot) => slot.layer),
    ['L1'],
  );
  assert.deepEqual(
    result.released.map((slot) => slot.layer),
    ['L2', 'L3'],
  );
  assert.ok(result.released.every((slot) => slot.amount === 500));
});

test('acceptance 4a: fully enumerated infeasible space proves UNSAT', () => {
  const input = baseInput({
    reviewers: [{ id: 'R1', groups: ['asset', 'revenue'] }],
    approvalLayers: [{ id: 'L1' }, { id: 'L2' }],
    budget: 1000,
  });
  const result = solve(input);
  assert.equal(result.status, 'UNSAT');
  assert.ok(result.conflictCore.some((line) => line.startsWith('assignment:')));
  assert.equal(bruteForce(input).feasible, false, 'enumeration agrees there is no solution');
});

test('acceptance 4b: exhausted budget yields PENDING with pending voucher, never UNSAT', () => {
  const input = baseInput({
    reviewers: [
      { id: 'R1', groups: ['asset', 'revenue'] },
      { id: 'R2', groups: ['asset', 'revenue'] },
      { id: 'R3', groups: ['asset', 'revenue'] },
    ],
    approvalLayers: [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }],
    budget: 1,
  });
  const result = solve(input);
  assert.equal(result.status, 'PENDING');
  assert.notEqual(result.status, 'UNSAT');
  assert.ok(result.pendingVoucher);
  assert.equal(result.pendingVoucher.voucherNo, 'ADJ-001');
  assert.ok(result.conflictCore.some((line) => line.startsWith('budget:')));
});

test('unbalanced entries are UNSAT with a balance conflict core', () => {
  const result = solve(
    baseInput({
      entries: [
        { account: '1001', direction: 'debit', amount: 500 },
        { account: '6001', direction: 'credit', amount: 400 },
      ],
    }),
  );
  assert.equal(result.status, 'UNSAT');
  assert.ok(result.conflictCore.some((line) => line.startsWith('balance:')));
});

test('layer with empty permission domain is UNSAT via domain propagation', () => {
  const result = solve(
    baseInput({
      reviewers: [{ id: 'R1', groups: ['asset'] }],
      approvalLayers: [{ id: 'L1' }],
    }),
  );
  assert.equal(result.status, 'UNSAT');
  assert.ok(result.conflictCore.some((line) => line.startsWith('domain:')));
});

test('enumeration comparison: solver matches brute force over <=3 reviewers and 2 periods', () => {
  const reviewerPools = [
    [{ id: 'R1', groups: ['asset', 'revenue'] }],
    [
      { id: 'R1', groups: ['asset', 'revenue'] },
      { id: 'R2', groups: ['asset'] },
    ],
    [
      { id: 'R1', groups: ['asset', 'revenue'] },
      { id: 'R2', groups: ['asset', 'revenue'] },
      { id: 'R3', groups: ['revenue'] },
    ],
  ];
  const periodSets = [
    [
      { id: '2026-09', status: 'closed', adjustmentPeriod: '2026-10' },
      { id: '2026-10', status: 'open' },
    ],
    [
      { id: '2026-09', status: 'open' },
      { id: '2026-10', status: 'closed', adjustmentPeriod: '2026-09' },
    ],
  ];
  for (const reviewers of reviewerPools) {
    for (const periods of periodSets) {
      for (const layerCount of [1, 2, 3]) {
        for (const requestedPeriod of ['2026-09', '2026-10']) {
          const input = baseInput({
            reviewers,
            periods,
            requestedPeriod,
            approvalLayers: Array.from({ length: layerCount }, (_, i) => ({
              id: `L${i + 1}`,
            })),
            budget: 10000,
          });
          const result = solve(input);
          const brute = bruteForce(input);
          const solverFeasible = result.status === 'APPROVED' || result.status === 'REJECTED';
          assert.equal(
            solverFeasible,
            brute.feasible,
            `mismatch for reviewers=${reviewers.length} layers=${layerCount} period=${requestedPeriod}`,
          );
          assert.notEqual(result.status, 'PENDING', 'large budget must fully determine');
        }
      }
    }
  }
});

test('unknown account throws InputError', () => {
  assert.throws(
    () => solve(baseInput({ entries: [{ account: '9999', direction: 'debit', amount: 1 }] })),
    InputError,
  );
});

test('revocation of a nonexistent layer throws InputError', () => {
  assert.throws(() => solve(baseInput({ revocations: ['L9'] })), InputError);
});

function runCli(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'output.json');
  const stderrPath = path.join(dir, 'stderr.txt');
  fs.writeFileSync(inputPath, JSON.stringify(input));
  return new Promise((resolve, reject) => {
    const stderrFd = fs.openSync(stderrPath, 'w');
    const child = spawn(process.execPath, ['.', 'audit', inputPath, outputPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', stderrFd],
    });
    child.on('error', reject);
    child.on('close', (status) => {
      fs.closeSync(stderrFd);
      const output = fs.existsSync(outputPath)
        ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
        : null;
      resolve({ status, stderr: fs.readFileSync(stderrPath, 'utf8'), output });
    });
  });
}

test('cli: node . audit writes the result file and exits 0', async () => {
  const { status, output } = await runCli(baseInput());
  assert.equal(status, 0);
  assert.equal(output.status, 'APPROVED');
  assert.equal(output.voucherNo, 'ADJ-001');
  assert.ok(Array.isArray(output.approvalTrail));
  assert.ok(Array.isArray(output.occupied));
  assert.ok(Array.isArray(output.released));
  assert.ok(Array.isArray(output.conflictCore));
});

test('cli: unknown account exits with code 1', async () => {
  const { status, stderr, output } = await runCli(
    baseInput({ entries: [{ account: '9999', direction: 'debit', amount: 1 }] }),
  );
  assert.equal(status, 1);
  assert.equal(output, null);
  assert.match(stderr, /unknown account/);
});

test('cli: revocation of a nonexistent layer exits with code 1', async () => {
  const { status, stderr, output } = await runCli(baseInput({ revocations: ['L9'] }));
  assert.equal(status, 1);
  assert.equal(output, null);
  assert.match(stderr, /unknown layer/);
});
