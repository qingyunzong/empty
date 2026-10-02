'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAllocation } = require('../lib/allocator');
const { main: cliMain } = require('../lib/cli');

const TIERS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

function centers3(extra = {}) {
  return [
    { id: 'A', minRatio: 20, ...extra.A },
    { id: 'B', minRatio: 20, ...extra.B },
    { id: 'C', minRatio: 20, ...extra.C },
  ];
}

function ratiosOf(output) {
  return Object.fromEntries(output.allocation.map((a) => [a.center, a.ratio]));
}

// Brute-force enumeration of every tier combination (<=3 centers).
function enumerate(centers, tiers, totalAmount) {
  const feasible = [];
  const totalCents = Math.round(totalAmount * 100);
  const rec = (i, sum, acc) => {
    if (i === centers.length) {
      if (sum === 100) feasible.push({ ...acc });
      return;
    }
    const c = centers[i];
    for (const t of tiers) {
      if (c.minRatio != null && t < c.minRatio) continue;
      if (c.maxRatio != null && t > c.maxRatio) continue;
      if (c.cap != null && Math.round((totalCents * t) / 100) > Math.round(c.cap * 100)) continue;
      acc[c.id] = t;
      rec(i + 1, sum + t, acc);
      delete acc[c.id];
    }
  };
  rec(0, 0, {});
  return feasible;
}

test('acceptance 1: three centers feasible, ratios sum to 100', () => {
  const out = runAllocation({
    totalAmount: 10000,
    tiers: TIERS,
    centers: centers3(),
  });
  assert.equal(out.status, 'OK');
  const ratios = ratiosOf(out);
  assert.equal(ratios.A + ratios.B + ratios.C, 100);
  const amounts = out.allocation.map((a) => a.amount);
  assert.ok(Math.abs(amounts.reduce((x, y) => x + y, 0) - 10000) < 1e-6);
  assert.equal(out.lockedAmount, 0);
  assert.equal(out.pendingAmount, 10000);
  assert.ok(out.trace.some((e) => e.type === 'recompute' && e.reason === 'init'));
});

test('acceptance 2: adjustment locks a center and incrementally re-selects the rest', () => {
  const out = runAllocation({
    totalAmount: 10000,
    tiers: TIERS,
    centers: centers3(),
    adjustments: [{ id: 'ADJ-1', center: 'A', ratio: 50 }],
  });
  assert.equal(out.status, 'OK');
  const ratios = ratiosOf(out);
  assert.equal(ratios.A, 50);
  assert.equal(ratios.A + ratios.B + ratios.C, 100);
  // Base solution is A=20,B=20,C=60; after locking A=50 the rest is re-selected.
  assert.deepEqual(ratios, { A: 50, B: 20, C: 30 });
  const a = out.allocation.find((x) => x.center === 'A');
  assert.equal(a.locked, true);
  assert.equal(out.lockedAmount, 5000);
  assert.equal(out.pendingAmount, 5000);
  assert.ok(out.trace.some((e) => e.type === 'adjust' && e.doc === 'ADJ-1'));
  assert.ok(out.trace.some((e) => e.type === 'recompute' && e.reason === 'adjust:ADJ-1'));
});

test('adjustment on a locked center is rejected and traced', () => {
  const out = runAllocation({
    totalAmount: 10000,
    tiers: TIERS,
    centers: centers3(),
    adjustments: [
      { id: 'ADJ-1', center: 'A', ratio: 50 },
      { id: 'ADJ-2', center: 'A', ratio: 60 },
    ],
  });
  assert.equal(out.status, 'OK');
  assert.equal(ratiosOf(out).A, 50);
  assert.ok(out.trace.some((e) => e.type === 'adjust-rejected' && e.doc === 'ADJ-2'));
});

test('acceptance 3: mutually exclusive caps yield UNSAT with minimal conflict set', () => {
  const out = runAllocation({
    totalAmount: 10000,
    tiers: TIERS,
    centers: centers3({ A: { cap: 3000 }, B: { cap: 3000 }, C: { cap: 3000 } }),
  });
  assert.equal(out.status, 'UNSAT');
  assert.deepEqual(out.conflictCenters.sort(), ['A', 'B', 'C']);
  assert.ok(out.trace.some((e) => e.type === 'propagate'));
});

test('acceptance 4: search budget exhaustion yields PENDING, never UNSAT', () => {
  const out = runAllocation({
    totalAmount: 10000,
    tiers: TIERS,
    centers: centers3(),
    searchBudget: 1,
  });
  assert.equal(out.status, 'PENDING');
  assert.ok(out.trace.some((e) => e.type === 'budget-exceeded'));
});

test('cancellation restores the previous occupancy layer', () => {
  const out = runAllocation({
    totalAmount: 10000,
    tiers: TIERS,
    centers: centers3(),
    adjustments: [{ id: 'ADJ-1', center: 'A', ratio: 50 }],
    cancellations: ['ADJ-1'],
  });
  assert.equal(out.status, 'OK');
  // Occupancy before ADJ-1 was A=20,B=20,C=60 and is restored after cancel.
  assert.deepEqual(ratiosOf(out), { A: 20, B: 20, C: 60 });
  const cancelEvent = out.trace.find((e) => e.type === 'cancel');
  assert.deepEqual(cancelEvent.restoredRatios, { A: 20, B: 20, C: 60 });
  assert.equal(out.lockedAmount, 0);
});

test('enumeration cross-check for <=3 centers matches solver feasibility', () => {
  const scenarios = [
    { centers: [{ id: 'A' }], tiers: [0, 50, 100], totalAmount: 5000 },
    { centers: [{ id: 'A', cap: 4000 }, { id: 'B' }], tiers: TIERS, totalAmount: 10000 },
    { centers: [{ id: 'A', cap: 1000 }, { id: 'B', cap: 1000 }], tiers: TIERS, totalAmount: 10000 },
    { centers: centers3(), tiers: TIERS, totalAmount: 10000 },
    {
      centers: [
        { id: 'A', minRatio: 10, maxRatio: 40 },
        { id: 'B', minRatio: 10, maxRatio: 40 },
        { id: 'C', minRatio: 30 },
      ],
      tiers: TIERS,
      totalAmount: 12345.67,
    },
    {
      centers: [
        { id: 'A', cap: 2000 },
        { id: 'B', cap: 2000 },
        { id: 'C', cap: 2000 },
      ],
      tiers: TIERS,
      totalAmount: 10000,
    },
  ];
  for (const s of scenarios) {
    const out = runAllocation({
      totalAmount: s.totalAmount,
      tiers: s.tiers,
      centers: s.centers,
    });
    const feasible = enumerate(s.centers, s.tiers, s.totalAmount);
    assert.equal(
      out.status === 'OK',
      feasible.length > 0,
      `feasibility mismatch for ${JSON.stringify(s.centers)}`
    );
    if (out.status === 'OK') {
      const ratios = ratiosOf(out);
      assert.ok(
        feasible.some((f) => Object.keys(f).every((k) => f[k] === ratios[k])),
        'solver assignment must appear in the enumerated feasible set'
      );
    } else {
      assert.equal(out.status, 'UNSAT');
      assert.ok(out.conflictCenters.length > 0);
    }
  }
});

function runCli(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alloc-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'output.json');
  fs.writeFileSync(inputPath, JSON.stringify(input));
  const stderr = [];
  const status = cliMain(['allocate', inputPath, outputPath], {
    stderr: (m) => stderr.push(m),
    stdout: () => {},
  });
  const output = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : null;
  return { status, stderr: stderr.join('\n'), output };
}

test('CLI allocate writes output and exits 0', () => {
  const { status, output } = runCli({
    totalAmount: 10000,
    tiers: TIERS,
    centers: centers3(),
  });
  assert.equal(status, 0);
  assert.equal(output.status, 'OK');
});

test('CLI exits 1 when the provided ratio set does not sum to 100', () => {
  const { status, stderr } = runCli({
    totalAmount: 10000,
    tiers: TIERS,
    centers: centers3(),
    ratios: { A: 40, B: 30, C: 20 },
  });
  assert.equal(status, 1);
  assert.match(stderr, /expected 100/);
});

test('CLI exits 1 when cancelling an already-cancelled document', () => {
  const { status, stderr } = runCli({
    totalAmount: 10000,
    tiers: TIERS,
    centers: centers3(),
    adjustments: [{ id: 'ADJ-1', center: 'A', ratio: 50 }],
    cancellations: ['ADJ-1', 'ADJ-1'],
  });
  assert.equal(status, 1);
  assert.match(stderr, /already cancelled/);
});

test('CLI exits 1 when cancelling an unknown document', () => {
  const { status, stderr } = runCli({
    totalAmount: 10000,
    tiers: TIERS,
    centers: centers3(),
    cancellations: ['NOPE'],
  });
  assert.equal(status, 1);
  assert.match(stderr, /unknown document/);
});
