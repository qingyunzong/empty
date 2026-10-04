'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ToolLifeService, MonotonicityError } = require('../src/service');
const { main } = require('../cli');

const CLI = path.join(__dirname, '..', 'cli.js');

function measure(seq, wear, tool = 'T1') {
  return { type: 'MEASURE', tool, wear, seq };
}

function runCli(ops, args = ['--limit', '80', '--max', '3']) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-ops-')),
    'ops.json'
  );
  fs.writeFileSync(file, JSON.stringify(ops));
  return file;
}

function invokeMain(ops, args = ['--limit', '80', '--max', '3']) {
  const file = runCli(ops, args);
  const out = [];
  const err = [];
  const status = main([file, ...args], {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  });
  return { status, stdout: out.join(''), stderr: err.join('') };
}

test('acceptance 1: retransmit and reorder never double-accumulate', () => {
  const svc = new ToolLifeService({ limit: 80, maxBudget: 3 });
  const ops = [
    measure(1, 10),
    measure(2, 25),
    measure(2, 25), // exact retransmit
    measure(1, 10), // retransmit of older seq
    measure(4, 60), // newer arrives before seq 3
    measure(3, 40), // out-of-order old measure
    measure(4, 60), // retransmit of newest
    measure(5, 79),
  ];
  svc.applyAll(ops);

  assert.equal(svc.snapshot().tools.T1.wear, 79);
  assert.equal(svc.snapshot().tools.T1.lastSeq, 5);
  const applied = svc.curve.filter((p) => p.event === 'MEASURE');
  assert.deepEqual(applied.map((p) => p.seq), [1, 2, 4, 5]);
  assert.equal(svc.ignored.length, 4);
  assert.ok(svc.ignored.every((e) => e.code === 'STALE_SEQ'));
});

test('duplicate CHANGE/RESET are idempotent and do not consume budget twice', () => {
  const svc = new ToolLifeService({ limit: 80, maxBudget: 3 });
  svc.applyAll([
    measure(1, 90),
    { type: 'CHANGE', tool: 'T1', new: 'T2', seq: 2 },
    { type: 'CHANGE', tool: 'T1', new: 'T2', seq: 2 }, // retransmit
    measure(3, 85, 'T2'),
    { type: 'RESET', tool: 'T2', admin: 'root', seq: 4 },
    { type: 'RESET', tool: 'T2', admin: 'root', seq: 4 }, // retransmit
  ]);
  assert.equal(svc.snapshot().budgetUsed, 2);
  assert.equal(svc.snapshot().tools.T2.wear, 0);
  assert.equal(svc.ignored.filter((e) => e.code === 'DUPLICATE').length, 2);
});

test('acceptance 2: RESET rejected while CHANGE is unconfirmed', () => {
  const svc = new ToolLifeService({ limit: 80, maxBudget: 3 });
  svc.apply(measure(1, 95));
  svc.apply({ type: 'CHANGE', tool: 'T1', new: 'T2', seq: 2 });

  const rejected = svc.apply({ type: 'RESET', tool: 'T2', admin: 'root', seq: 3 });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.code, 'CHANGE_PENDING');
  assert.equal(svc.snapshot().budgetUsed, 1); // only the CHANGE consumed budget
  assert.equal(svc.snapshot().tools.T2.wear, 0);

  // first MEASURE for the new tool confirms the CHANGE
  svc.apply(measure(4, 0, 'T2'));
  assert.equal(svc.snapshot().pendingChange, null);
});

test('acceptance 3: exact limit boundary for alarm and RESET', () => {
  const svc = new ToolLifeService({ limit: 80, maxBudget: 3 });

  svc.apply(measure(1, 79));
  assert.equal(svc.alarms.length, 0);
  const below = svc.apply({ type: 'RESET', tool: 'T1', admin: 'root', seq: 2 });
  assert.equal(below.code, 'BELOW_LIMIT');
  assert.equal(svc.snapshot().budgetUsed, 0);

  svc.apply(measure(3, 80)); // exactly at limit
  assert.equal(svc.alarms.length, 1);
  assert.equal(svc.alarms[0].wear, 80);

  const ok = svc.apply({ type: 'RESET', tool: 'T1', admin: 'root', seq: 4 });
  assert.equal(ok.accepted, true);
  assert.equal(svc.snapshot().tools.T1.wear, 0);
  assert.equal(svc.snapshot().budgetUsed, 1);
});

test('RESET without admin is rejected', () => {
  const svc = new ToolLifeService({ limit: 80, maxBudget: 3 });
  svc.apply(measure(1, 100));
  const res = svc.apply({ type: 'RESET', tool: 'T1', seq: 2 });
  assert.equal(res.code, 'NO_ADMIN');
  assert.equal(svc.snapshot().tools.T1.wear, 100);
});

test('virtual clock expires MEASURE outside the window, evidence kept', () => {
  const svc = new ToolLifeService({ limit: 80, maxBudget: 3, window: 5 });
  svc.apply({ type: 'MEASURE', tool: 'T1', wear: 10, seq: 1, t: 0, sent: 0 });
  const res = svc.apply({ type: 'MEASURE', tool: 'T1', wear: 20, seq: 2, t: 10, sent: 2 });
  assert.equal(res.ignored, true);
  assert.equal(res.code, 'EXPIRED');
  assert.equal(svc.snapshot().tools.T1.wear, 10);
  assert.equal(svc.ignored.length, 1);
  assert.equal(svc.ignored[0].op.seq, 2); // evidence retained
});

test('monotonicity violation on fresh MEASURE throws MonotonicityError', () => {
  const svc = new ToolLifeService({ limit: 80, maxBudget: 3 });
  svc.apply(measure(1, 50));
  assert.throws(() => svc.apply(measure(2, 40)), MonotonicityError);
});

test('acceptance 4: brute-force replay of permuted+duplicated streams matches canonical', () => {
  const wears = [10, 20, 30, 40];
  const canonical = new ToolLifeService({ limit: 80, maxBudget: 3 });
  canonical.applyAll(wears.map((w, i) => measure(i + 1, w)));
  const expected = canonical.snapshot();

  // all 24 permutations of seq 1..4
  function* permutations(arr) {
    if (arr.length <= 1) {
      yield arr;
      return;
    }
    for (let i = 0; i < arr.length; i += 1) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutations(rest)) yield [arr[i], ...p];
    }
  }

  let checked = 0;
  for (const perm of permutations([1, 2, 3, 4])) {
    // inject duplicates: replay every message a second time, plus the first one thrice
    const seqs = [...perm, ...perm, perm[0]];
    const svc = new ToolLifeService({ limit: 80, maxBudget: 3 });
    svc.applyAll(seqs.map((s) => measure(s, wears[s - 1])));
    assert.deepEqual(svc.snapshot(), expected, `permutation ${perm}`);
    checked += 1;
  }
  assert.equal(checked, 24);
});

test('budget: over-limit command rejected without half-commit, exit 5', () => {
  const svc = new ToolLifeService({ limit: 80, maxBudget: 1 });
  svc.apply(measure(1, 90));
  const first = svc.apply({ type: 'CHANGE', tool: 'T1', new: 'T2', seq: 2 });
  assert.equal(first.accepted, true);
  svc.apply(measure(3, 0, 'T2')); // confirm change
  svc.apply(measure(4, 95, 'T2'));
  const second = svc.apply({ type: 'RESET', tool: 'T2', admin: 'root', seq: 5 });
  assert.equal(second.code, 'BUDGET_EXCEEDED');
  // no half-commit: wear untouched, budget unchanged
  assert.equal(svc.snapshot().tools.T2.wear, 95);
  assert.equal(svc.snapshot().budgetUsed, 1);
});

test('cli exits 0 and prints report on a clean run', () => {
  const res = invokeMain([measure(1, 10), measure(2, 20)]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.final.tools.T1.wear, 20);
  assert.equal(report.curve.length, 2);
});

test('cli exits 11 on monotonicity violation', () => {
  const res = invokeMain([measure(1, 50), measure(2, 40)]);
  assert.equal(res.status, 11, res.stderr);
  assert.match(res.stderr, /monotonicity violation/);
});

test('cli exits 5 on budget exhaustion', () => {
  const res = invokeMain(
    [
      measure(1, 90),
      { type: 'CHANGE', tool: 'T1', new: 'T2', seq: 2 },
      measure(3, 0, 'T2'),
      measure(4, 95, 'T2'),
      { type: 'RESET', tool: 'T2', admin: 'root', seq: 5 },
    ],
    ['--limit', '80', '--max', '1']
  );
  assert.equal(res.status, 5, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.rejections.at(-1).code, 'BUDGET_EXCEEDED');
});

test('cli exits 2 on bad usage', () => {
  const err = [];
  const status = main([], {
    stdout: { write: () => {} },
    stderr: { write: (s) => err.push(s) },
  });
  assert.equal(status, 2);
  assert.match(err.join(''), /usage:/);
});

test('cli real process exit codes (skipped when spawn is sandboxed)', (t) => {
  const file = runCli([measure(1, 50), measure(2, 40)]);
  const res = spawnSync(process.execPath, [CLI, file, '--limit', '80', '--max', '3'], {
    encoding: 'utf8',
  });
  if (res.error && res.error.code === 'EPERM') {
    t.skip('child process spawn blocked by sandbox');
    return;
  }
  assert.equal(res.status, 11);
});
