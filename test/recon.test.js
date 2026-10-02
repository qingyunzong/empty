import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  reconcile,
  parseJsonl,
  greedyMatch,
  bruteForceMatch,
  matchAmounts,
  ReconError,
} from '../src/recon.js';

const BIN = fileURLToPath(new URL('../bin/recon.js', import.meta.url));

let seq = 0;
const rec = (source, amount, extra = {}) => ({
  id: `${source}#${++seq}`,
  explicitId: null,
  valueDate: '2026-01-05',
  account: 'ACC1',
  ccy: 'USD',
  amount,
  link: null,
  ...extra,
});
const B = (amount, extra) => rec('bank', amount, extra);
const C = (amount, extra) => rec('core', amount, extra);
const A = (amount, extra) => rec('adj', amount, extra);

test('tolerance match records rounding', () => {
  const { entries, conflicts } = reconcile({
    bank: [B(100)],
    core: [C(100.004)],
    adj: [],
    tol: 0.01,
  });
  assert.equal(entries.length, 1);
  assert.equal(conflicts.length, 0);
  assert.equal(entries[0].amount, 100);
  assert.equal(entries[0].rounding.core, 0.004);
  assert.equal(entries[0].rounding.adj, null);
});

test('exact match has zero rounding', () => {
  const { entries } = reconcile({ bank: [B(42.5)], core: [C(42.5)], adj: [], tol: 0 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rounding.core, 0);
});

test('MISSING_CORE and UNSETTLED', () => {
  const { entries, conflicts } = reconcile({
    bank: [B(100)],
    core: [C(200, { valueDate: '2026-01-06' })],
    adj: [],
    tol: 0,
  });
  assert.equal(entries.length, 0);
  assert.deepEqual(
    conflicts.map((c) => c.rule).sort(),
    ['MISSING_CORE', 'UNSETTLED'],
  );
  for (const c of conflicts) assert.match(c.hash, /^[0-9a-f]{64}$/);
});

test('ADJ_CONFLICT via link, entry suppressed', () => {
  const bank = [B(100, { explicitId: 'E1' })];
  const core = [C(100, { explicitId: 'E1' })];
  const adj = [A(150, { link: 'E1' })];
  const { entries, conflicts } = reconcile({ bank, core, adj, tol: 0.01 });
  assert.equal(entries.length, 0);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].rule, 'ADJ_CONFLICT');
  assert.equal(conflicts[0].key, 'id:E1');
});

test('three-way agreement books entry with adj rounding', () => {
  const bank = [B(100)];
  const core = [C(100.002)];
  const adj = [A(100.003, { link: '2026-01-05|ACC1|USD|100' })];
  const { entries, conflicts } = reconcile({ bank, core, adj, tol: 0.01 });
  assert.equal(conflicts.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rounding.core, 0.002);
  assert.equal(entries[0].rounding.adj, 0.003);
});

test('THREE_WAY: same explicitId, pairwise different amounts', () => {
  const bank = [B(100, { explicitId: 'T1' })];
  const core = [C(101, { explicitId: 'T1' })];
  const adj = [A(102, { explicitId: 'T1' })];
  const { entries, conflicts } = reconcile({ bank, core, adj, tol: 0.005 });
  assert.equal(entries.length, 0);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].rule, 'THREE_WAY');
  assert.deepEqual(conflicts[0].amounts, { bank: [100], core: [101], adj: [102] });
});

test('multiset matching on same key', () => {
  const { entries, conflicts } = reconcile({
    bank: [B(100), B(100), B(200)],
    core: [C(100), C(200)],
    adj: [],
    tol: 0,
  });
  assert.equal(entries.length, 2);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].rule, 'MISSING_CORE');
  assert.deepEqual(conflicts[0].amounts.bank, [100]);
});

test('tie-break by date/id lexicographic order', () => {
  // valueDate is part of the group key, so within one group the tie is
  // broken by id lexicographic order (canonical order: amount, date, id).
  const late = B(100, { id: 'bank#zzz' });
  const early = B(100, { id: 'bank#aaa' });
  const { entries, conflicts } = reconcile({
    bank: [late, early],
    core: [C(100)],
    adj: [],
    tol: 0,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].bankId, 'bank#aaa');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].rule, 'MISSING_CORE');
  assert.deepEqual(conflicts[0].bank, ['bank#zzz']);
});

test('tie-break by date inside explicitId group', () => {
  const late = B(100, { id: 'bank#1', explicitId: 'E9', valueDate: '2026-01-02' });
  const early = B(100, { id: 'bank#2', explicitId: 'E8', valueDate: '2026-01-01' });
  const { entries, conflicts } = reconcile({
    bank: [late, early],
    core: [C(100, { explicitId: 'E8', valueDate: '2026-01-01' })],
    adj: [],
    tol: 0,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].bankId, 'bank#2');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].bank, ['bank#1']);
});

test('greedy matches brute-force enumeration for n<=7 (randomized)', () => {
  let s = 12345;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let iter = 0; iter < 300; iter++) {
    const n = Math.floor(rand() * 8);
    const m = Math.floor(rand() * 8);
    const tol = rand() * 2;
    const bank = Array.from({ length: n }, (_, i) =>
      B(Math.floor(rand() * 10), { id: `b${i}`, valueDate: `2026-01-0${(i % 9) + 1}` }),
    );
    const core = Array.from({ length: m }, (_, i) =>
      C(Math.floor(rand() * 10), { id: `c${i}`, valueDate: `2026-01-0${(i % 9) + 1}` }),
    );
    const greedy = greedyMatch(bank, core, tol);
    const brute = bruteForceMatch(bank, core, tol);
    assert.equal(
      greedy.pairs.length,
      brute.pairs.length,
      `iter ${iter}: greedy ${greedy.pairs.length} != brute ${brute.pairs.length}`,
    );
    const viaLib = matchAmounts(bank, core, tol);
    assert.deepEqual(viaLib, brute, `iter ${iter}: matchAmounts must use canonical enumeration`);
    assert.deepEqual(bruteForceMatch(bank, core, tol), brute, `iter ${iter}: non-deterministic`);
  }
});

test('reconcile is deterministic', () => {
  const input = {
    bank: [B(100), B(100.005), B(300), B(400)],
    core: [C(100.001), C(100.004), C(300)],
    adj: [A(100.002, { link: '2026-01-05|ACC1|USD|100' })],
    tol: 0.01,
  };
  const first = reconcile(structuredClone(input));
  const second = reconcile(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('parseJsonl rejects duplicate explicitId with exit 18', () => {
  assert.throws(
    () => parseJsonl('{"explicitId":"X","valueDate":"d","account":"a","ccy":"USD","amount":1}\n{"explicitId":"X","valueDate":"d","account":"a","ccy":"USD","amount":2}\n', 'bank'),
    (err) => err instanceof ReconError && err.exitCode === 18,
  );
});

test('reconcile rejects negative tolerance with exit 19', () => {
  assert.throws(() => reconcile({ bank: [], core: [], adj: [], tol: -0.5 }), (err) => err.exitCode === 19);
});

test('dangling adj link exits 20', () => {
  assert.throws(
    () => reconcile({ bank: [B(1)], core: [], adj: [A(1, { link: 'NOPE' })], tol: 0 }),
    (err) => err.exitCode === 20,
  );
  assert.throws(
    () => reconcile({ bank: [B(1)], core: [], adj: [A(1, { link: '2026-01-05|ACC1|USD|999' })], tol: 0 }),
    (err) => err.exitCode === 20,
  );
});

// ---- CLI end-to-end ----

function runCli(files, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'recon-'));
  const paths = {};
  for (const [name, lines] of Object.entries(files)) {
    paths[name] = join(dir, `${name}.jsonl`);
    writeFileSync(paths[name], lines.join('\n') + '\n');
  }
  const out = join(dir, 'entries.jsonl');
  const conflicts = join(dir, 'c.json');
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  const cmd =
    [q(process.execPath), q(BIN), q(paths.bank), q(paths.core), q(paths.adj),
     '--out', q(out), '--conflicts', q(conflicts), ...extraArgs.map(q)].join(' ') +
    ` >${q(stdoutPath)} 2>${q(stderrPath)}`;
  const spawned = spawnSync(cmd, { shell: true });
  const readOut = () =>
    readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const readConflicts = () => JSON.parse(readFileSync(conflicts, 'utf8'));
  const res = {
    status: spawned.status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
  return { res, readOut, readConflicts };
}

const BANK_LINE = JSON.stringify({ valueDate: '2026-01-05', account: 'ACC1', ccy: 'USD', amount: 100 });
const CORE_LINE = JSON.stringify({ valueDate: '2026-01-05', account: 'ACC1', ccy: 'USD', amount: 100.004 });

test('CLI happy path: tolerance match with rounding', () => {
  const { res, readOut, readConflicts } = runCli(
    { bank: [BANK_LINE], core: [CORE_LINE], adj: [] },
    ['--tol', '0.01'],
  );
  assert.equal(res.status, 0, res.stderr);
  const entries = readOut();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rounding.core, 0.004);
  assert.deepEqual(readConflicts(), []);
  assert.match(res.stdout, /entries=1 conflicts=0/);
});

test('CLI duplicate explicitId exits 18', () => {
  const dup = JSON.stringify({ explicitId: 'X', valueDate: 'd', account: 'a', ccy: 'USD', amount: 1 });
  const { res } = runCli({ bank: [dup, dup], core: [], adj: [] });
  assert.equal(res.status, 18);
  assert.match(res.stderr, /duplicate explicitId/);
});

test('CLI negative tolerance exits 19', () => {
  const { res } = runCli({ bank: [], core: [], adj: [] }, ['--tol=-0.1']);
  assert.equal(res.status, 19);
  assert.match(res.stderr, /negative tolerance/);
});

test('CLI dangling adj link exits 20', () => {
  const adj = JSON.stringify({ amount: 5, link: 'GHOST' });
  const { res } = runCli({ bank: [BANK_LINE], core: [CORE_LINE], adj: [adj] }, ['--tol', '0.01']);
  assert.equal(res.status, 20);
  assert.match(res.stderr, /dangling/);
});

test('CLI reports all conflict classes', () => {
  const bank = [
    JSON.stringify({ explicitId: 'T1', valueDate: '2026-01-05', account: 'A', ccy: 'USD', amount: 100 }),
    JSON.stringify({ valueDate: '2026-01-06', account: 'A', ccy: 'USD', amount: 50 }),
    JSON.stringify({ explicitId: 'E1', valueDate: '2026-01-07', account: 'A', ccy: 'USD', amount: 10 }),
  ];
  const core = [
    JSON.stringify({ explicitId: 'T1', valueDate: '2026-01-05', account: 'A', ccy: 'USD', amount: 101 }),
    JSON.stringify({ valueDate: '2026-01-08', account: 'A', ccy: 'USD', amount: 70 }),
    JSON.stringify({ explicitId: 'E1', valueDate: '2026-01-07', account: 'A', ccy: 'USD', amount: 10 }),
  ];
  const adj = [
    JSON.stringify({ explicitId: 'T1', amount: 102 }),
    JSON.stringify({ amount: 99, link: 'E1' }),
  ];
  const { res, readConflicts } = runCli({ bank, core, adj }, ['--tol', '0.005']);
  assert.equal(res.status, 0, res.stderr);
  const rules = readConflicts().map((c) => c.rule).sort();
  assert.deepEqual(rules, ['ADJ_CONFLICT', 'MISSING_CORE', 'THREE_WAY', 'UNSETTLED']);
});
