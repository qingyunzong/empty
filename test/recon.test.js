'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ReconError,
  parseJsonl,
  matchAmounts,
  reconcile,
  canonicalHash,
  stableStringify,
} = require('../lib/recon');

const { main } = require('../bin/recon');

function rec(amount, extra = {}) {
  return { amount, valueDate: '2026-01-01', account: 'A', ccy: 'USD', source: 'bank', seq: 0, explicitId: null, ...extra };
}

function runCli(args) {
  const stderrChunks = [];
  const stdoutChunks = [];
  const origStderr = process.stderr.write;
  const origStdout = process.stdout.write;
  process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
  process.stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };
  let status;
  try {
    status = main(args);
  } finally {
    process.stderr.write = origStderr;
    process.stdout.write = origStdout;
  }
  return { status, stderr: stderrChunks.join(''), stdout: stdoutChunks.join('') };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recon-test-'));
}

function writeJsonl(dir, name, rows) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

test('tolerance match records rounding', () => {
  const bank = [rec(100)];
  const core = [rec(100.004, { source: 'core' })];
  const { entries, conflicts } = reconcile({ bank, core, adj: [], tol: 0.01 });
  assert.equal(conflicts.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rounding, 0.004);
  assert.equal(entries[0].amount, 100);
  assert.equal(entries[0].coreAmount, 100.004);
  assert.match(entries[0].hash, /^[0-9a-f]{64}$/);
});

test('beyond tolerance does not match', () => {
  const bank = [rec(100)];
  const core = [rec(100.02, { source: 'core' })];
  const { entries, conflicts } = reconcile({ bank, core, adj: [], tol: 0.01 });
  assert.equal(entries.length, 0);
  assert.deepEqual(conflicts.map((c) => c.rule).sort(), ['MISSING_CORE', 'UNSETTLED']);
});

test('MISSING_CORE and UNSETTLED rules', () => {
  const bank = [rec(75, { valueDate: '2026-02-01', account: 'B' })];
  const core = [rec(40, { source: 'core', valueDate: '2026-02-02', account: 'C' })];
  const { entries, conflicts } = reconcile({ bank, core, adj: [], tol: 0 });
  assert.equal(entries.length, 0);
  const missing = conflicts.find((c) => c.rule === 'MISSING_CORE');
  const unsettled = conflicts.find((c) => c.rule === 'UNSETTLED');
  assert.ok(missing && unsettled);
  assert.equal(missing.bank.amount, 75);
  assert.equal(missing.core, null);
  assert.equal(unsettled.core.amount, 40);
  assert.equal(unsettled.bank, null);
});

test('ADJ_CONFLICT when adj disagrees with one side', () => {
  const bank = [rec(500, { explicitId: 'T1' })];
  const core = [rec(500, { source: 'core', explicitId: 'T1' })];
  const adj = [rec(510, { source: 'adj', explicitId: 'T1' })];
  const { entries, conflicts } = reconcile({ bank, core, adj, tol: 0.01 });
  assert.equal(entries.length, 0);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].rule, 'ADJ_CONFLICT');
  assert.equal(conflicts[0].adj.amount, 510);
});

test('THREE_WAY when same explicitId amounts pairwise differ', () => {
  const bank = [rec(900, { explicitId: 'T2' })];
  const core = [rec(900.5, { source: 'core', explicitId: 'T2' })];
  const adj = [rec(901.2, { source: 'adj', explicitId: 'T2' })];
  const { entries, conflicts } = reconcile({ bank, core, adj, tol: 0.01 });
  assert.equal(entries.length, 0);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].rule, 'THREE_WAY');
  assert.match(conflicts[0].hash, /^[0-9a-f]{64}$/);
});

test('consistent linked adj keeps entry bookable', () => {
  const bank = [rec(100, { explicitId: 'T3' })];
  const core = [rec(100.004, { source: 'core', explicitId: 'T3' })];
  const adj = [rec(100.002, { source: 'adj', link: { bank: 'T3', core: 'T3' } })];
  const { entries, conflicts } = reconcile({ bank, core, adj, tol: 0.01 });
  assert.equal(conflicts.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].adjAmount, 100.002);
});

test('same-key multiset matching pairs nearest amounts deterministically', () => {
  const bank = [rec(10), rec(10.005, { seq: 1 })];
  const core = [rec(10.004, { source: 'core', seq: 1 }), rec(10, { source: 'core' })];
  const first = reconcile({ bank, core, adj: [], tol: 0.01 });
  const second = reconcile({ bank, core, adj: [], tol: 0.01 });
  assert.equal(first.entries.length, 2);
  assert.deepEqual(first, second);
  const roundings = first.entries.map((e) => e.rounding).sort((a, b) => a - b);
  assert.deepEqual(roundings, [-0.001, 0]);
});

test('tie-break prefers lexicographic date/id order', () => {
  const bank = [rec(10)];
  const core = [
    rec(10.005, { source: 'core', explicitId: null, valueDate: '2026-01-02', seq: 2 }),
    rec(10.005, { source: 'core', explicitId: null, valueDate: '2026-01-01', seq: 1 }),
  ];
  const { pairs } = matchAmounts(bank, core, 0.01);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].core.valueDate, '2026-01-01');
});

// Independent Cartesian enumeration of all matchings: every bank record is
// assigned to at most one core record (or left unmatched), injectively.
function bruteForceMaxMatch(bankAmounts, coreAmounts, tol) {
  const n = bankAmounts.length;
  const m = coreAmounts.length;
  let best = 0;
  const used = new Array(m).fill(false);
  function dfs(i, count) {
    if (i === n) {
      best = Math.max(best, count);
      return;
    }
    dfs(i + 1, count);
    for (let j = 0; j < m; j += 1) {
      if (used[j]) continue;
      if (Math.abs(bankAmounts[i] - coreAmounts[j]) <= tol + 1e-9) {
        used[j] = true;
        dfs(i + 1, count + 1);
        used[j] = false;
      }
    }
  }
  dfs(0, 0);
  return best;
}

test('n<=7: matching count is maximal (Cartesian enumeration) and deterministic', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 200; trial += 1) {
    const n = 1 + Math.floor(rand() * 7);
    const m = 1 + Math.floor(rand() * 7);
    const tol = [0, 0.005, 0.05, 0.5][Math.floor(rand() * 4)];
    const bank = Array.from({ length: n }, (_, i) => rec(Math.round(rand() * 1000) / 100, { seq: i }));
    const core = Array.from({ length: m }, (_, i) => rec(Math.round(rand() * 1000) / 100, { source: 'core', seq: i }));
    const { pairs } = matchAmounts(bank, core, tol);
    const expected = bruteForceMaxMatch(bank.map((b) => b.amount), core.map((c) => c.amount), tol);
    assert.equal(pairs.length, expected, `trial ${trial}: n=${n} m=${m} tol=${tol}`);
    const again = matchAmounts(bank, core, tol);
    assert.deepEqual(
      again.pairs.map((p) => [p.bank.seq, p.core.seq]),
      pairs.map((p) => [p.bank.seq, p.core.seq]),
      `trial ${trial}: matching must be deterministic`,
    );
  }
});

test('duplicate explicitId exits 18', () => {
  assert.throws(() => parseJsonl('{"explicitId":"X","amount":1}\n{"explicitId":"X","amount":2}\n', 'bank'), (err) => {
    assert.ok(err instanceof ReconError);
    assert.equal(err.exitCode, 18);
    return true;
  });
  const dir = tmpdir();
  const bank = writeJsonl(dir, 'bank.jsonl', [{ explicitId: 'X', amount: 1 }, { explicitId: 'X', amount: 2 }]);
  const core = writeJsonl(dir, 'core.jsonl', []);
  const adj = writeJsonl(dir, 'adj.jsonl', []);
  const res = runCli([bank, core, adj, '--out', path.join(dir, 'e.jsonl'), '--conflicts', path.join(dir, 'c.json')]);
  assert.equal(res.status, 18);
  assert.match(res.stderr, /duplicate explicitId/);
});

test('negative tolerance exits 19', () => {
  const dir = tmpdir();
  const bank = writeJsonl(dir, 'bank.jsonl', []);
  const core = writeJsonl(dir, 'core.jsonl', []);
  const adj = writeJsonl(dir, 'adj.jsonl', []);
  const res = runCli([bank, core, adj, '--tol', '-0.5', '--out', path.join(dir, 'e.jsonl'), '--conflicts', path.join(dir, 'c.json')]);
  assert.equal(res.status, 19);
  assert.match(res.stderr, /tolerance/);
});

test('dangling adj link exits 20', () => {
  const dir = tmpdir();
  const bank = writeJsonl(dir, 'bank.jsonl', [{ explicitId: 'REAL', amount: 1 }]);
  const core = writeJsonl(dir, 'core.jsonl', [{ explicitId: 'REAL', amount: 1 }]);
  const adj = writeJsonl(dir, 'adj.jsonl', [{ amount: 1, link: { bank: 'GHOST' } }]);
  const res = runCli([bank, core, adj, '--out', path.join(dir, 'e.jsonl'), '--conflicts', path.join(dir, 'c.json')]);
  assert.equal(res.status, 20);
  assert.match(res.stderr, /dangling link/);
});

test('CLI end-to-end on fixtures', () => {
  const dir = tmpdir();
  const out = path.join(dir, 'entries.jsonl');
  const conf = path.join(dir, 'conflicts.json');
  const fixtures = path.join(__dirname, '..', 'fixtures');
  const res = runCli([
    path.join(fixtures, 'bank.jsonl'),
    path.join(fixtures, 'core.jsonl'),
    path.join(fixtures, 'adj.jsonl'),
    '--tol', '0.01',
    '--out', out,
    '--conflicts', conf,
  ]);
  assert.equal(res.status, 0, res.stderr);
  const entries = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  const conflicts = JSON.parse(fs.readFileSync(conf, 'utf8'));
  assert.equal(entries.length, 4);
  assert.deepEqual(conflicts.map((c) => c.rule).sort(), ['ADJ_CONFLICT', 'MISSING_CORE', 'THREE_WAY', 'UNSETTLED']);
  for (const c of conflicts) assert.match(c.hash, /^[0-9a-f]{64}$/);
  const linked = entries.find((e) => e.explicitId === 'TXN-100');
  assert.equal(linked.rounding, 0.004);
  assert.equal(linked.adjAmount, 100.002);
});

test('stableStringify is key-order independent', () => {
  const a = { x: 1, y: [2, { b: 1, a: 2 }] };
  const b = { y: [2, { a: 2, b: 1 }], x: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(canonicalHash(a), canonicalHash(b));
});
