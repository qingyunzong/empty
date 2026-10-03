import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseHistory,
  solve,
  judge,
  minimalConflict,
  bruteForce,
  accountBalances,
} from '../src/judge.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'judge.js');

function cmd(over) {
  return {
    opId: over.opId,
    session: over.session ?? 's',
    start: over.start ?? 0,
    end: over.end ?? 10,
    action: over.action,
    account: over.account ?? 'A',
    amount: over.amount ?? 1,
    depends: over.depends ?? [],
    balance: over.balance,
  };
}

function runCli(lines, { explain = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'judge-'));
  const input = join(dir, 'history.jsonl');
  writeFileSync(input, lines.join('\n') + '\n');
  const out = join(dir, 'out.json');
  const stdoutFile = join(dir, 'stdout.txt');
  const stderrFile = join(dir, 'stderr.txt');
  const args = [BIN, input];
  if (explain) args.push('--explain', out);
  // Note: pipe capture of child stdio is unreliable in this sandbox, so
  // stdout/stderr are redirected to files instead.
  const outFd = openSync(stdoutFile, 'w');
  const errFd = openSync(stderrFile, 'w');
  const res = spawnSync(process.execPath, args, { stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: res.status,
    stdout: readFileSync(stdoutFile, 'utf8').trim(),
    stderr: readFileSync(stderrFile, 'utf8').trim(),
    explain: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null,
  };
}

const line = (o) => JSON.stringify({ start: 0, end: 10, depends: [], account: 'A', ...o });

// ---------- acceptance: serializable interleaving returns a witness ----------

test('serializable freeze/debit interleaving returns witness', () => {
  const commands = parseHistory(
    [
      line({ opId: 'f1', action: 'FREEZE', account: 'A', amount: 50, balance: 100, start: 0, end: 2 }),
      line({ opId: 'd1', action: 'DEBIT', account: 'A', amount: 30, start: 1, end: 3 }),
      line({ opId: 'r1', action: 'RELEASE', account: 'A', amount: 10, start: 2, end: 4 }),
      line({ opId: 't1', action: 'SETTLE', account: 'A', amount: 10, start: 3, end: 5, depends: ['f1'] }),
    ].join('\n'),
  );
  const out = judge(commands);
  assert.equal(out.result, 'SAT');
  assert.deepEqual(out.witness, ['f1', 'd1', 'r1', 't1']);
});

// ---------- acceptance: insufficient freeze makes DEBIT fail ----------

test('insufficient frozen funds make DEBIT fail (UNSAT + conflict)', () => {
  const commands = [
    cmd({ opId: 'f', action: 'FREEZE', amount: 5, balance: 100 }),
    cmd({ opId: 'd1', action: 'DEBIT', amount: 3 }),
    cmd({ opId: 'd2', action: 'DEBIT', amount: 4 }),
  ];
  const out = judge(commands);
  assert.equal(out.result, 'UNSAT');
  // A lone DEBIT is already infeasible (frozen starts at 0), so the
  // minimum-cardinality conflict is the lexicographically smallest debit.
  assert.deepEqual(out.conflict, ['d1']);
  const byId = new Map(commands.map((c) => [c.opId, c]));
  assert.equal(solve(out.conflict.map((id) => byId.get(id))), null);
});

test('multi-element minimal conflict: cumulative freezes exceed balance', () => {
  const commands = [
    cmd({ opId: 'f1', action: 'FREEZE', amount: 6, balance: 10 }),
    cmd({ opId: 'f2', action: 'FREEZE', amount: 6 }),
    cmd({ opId: 'ok', action: 'FREEZE', amount: 1, account: 'B', balance: 5 }),
  ];
  const out = judge(commands);
  assert.equal(out.result, 'UNSAT');
  assert.deepEqual(out.conflict, ['f1', 'f2']);
  // genuinely minimal: each freeze alone fits within the balance
  const byId = new Map(commands.map((c) => [c.opId, c]));
  const balances = accountBalances(commands);
  for (const id of out.conflict) {
    const rest = out.conflict.filter((x) => x !== id).map((x) => byId.get(x));
    assert.notEqual(solve(rest, balances), null, `conflict not minimal: ${id} removable`);
  }
});

test('negative available (freeze exceeds balance) reported as UNSAT, distinct from cycle', () => {
  const commands = [cmd({ opId: 'f', action: 'FREEZE', amount: 10, balance: 5 })];
  const out = judge(commands);
  assert.equal(out.result, 'UNSAT');
  assert.deepEqual(out.conflict, ['f']);
  // and it is not reported as a depends cycle
  assert.doesNotThrow(() => parseHistory(line({ opId: 'f', action: 'FREEZE', amount: 10, balance: 5 })));
});

// ---------- acceptance: depends cycle vs negative balance reported separately ----------

test('depends cycle exits 13 via CLI', () => {
  const r = runCli([
    line({ opId: 'a', action: 'FREEZE', amount: 1, depends: ['b'] }),
    line({ opId: 'b', action: 'FREEZE', amount: 1, depends: ['a'] }),
  ]);
  assert.equal(r.status, 13);
  assert.match(r.stderr, /cycle/);
});

test('self dependency is a cycle (exit 13)', () => {
  const r = runCli([line({ opId: 'a', action: 'FREEZE', amount: 1, depends: ['a'] })]);
  assert.equal(r.status, 13);
});

test('depends must complete before dependent in witness', () => {
  const commands = [
    cmd({ opId: 'a', action: 'SETTLE', amount: 1, depends: ['b'] }),
    cmd({ opId: 'b', action: 'FREEZE', amount: 5, balance: 10 }),
  ];
  const out = judge(commands);
  assert.equal(out.result, 'SAT');
  assert.deepEqual(out.witness, ['b', 'a']);
});

// ---------- acceptance: lexicographically smallest witness ----------

test('ties among witnesses resolve to lexicographically smallest', () => {
  const commands = [
    cmd({ opId: 'c', action: 'FREEZE', amount: 1, balance: 10 }),
    cmd({ opId: 'a', action: 'FREEZE', amount: 1, account: 'B', balance: 10 }),
    cmd({ opId: 'b', action: 'FREEZE', amount: 1, account: 'C', balance: 10 }),
  ];
  assert.deepEqual(solve(commands), ['a', 'b', 'c']);
});

test('lexicographic minimum is among *valid* orders, not just sorted ids', () => {
  const commands = [
    cmd({ opId: 'a', action: 'DEBIT', amount: 5 }),
    cmd({ opId: 'b', action: 'FREEZE', amount: 5, balance: 5 }),
  ];
  // 'a' cannot go first (no frozen funds); only valid order is b,a
  assert.deepEqual(solve(commands), ['b', 'a']);
});

// ---------- interval constraints ----------

test('disjoint intervals force time order regardless of opId order', () => {
  const commands = [
    cmd({ opId: 'z', action: 'FREEZE', amount: 1, balance: 10, start: 0, end: 1 }),
    cmd({ opId: 'a', action: 'FREEZE', amount: 1, account: 'B', balance: 10, start: 2, end: 3 }),
  ];
  assert.deepEqual(solve(commands), ['z', 'a']);
});

test('invalid interval exits 12', () => {
  const r = runCli([line({ opId: 'a', action: 'FREEZE', amount: 1, start: 5, end: 2 })]);
  assert.equal(r.status, 12);
  assert.match(r.stderr, /interval/);
});

test('non-numeric interval exits 12', () => {
  const r = runCli([JSON.stringify({ opId: 'a', action: 'FREEZE', account: 'A', amount: 1, start: 'x', end: 2 })]);
  assert.equal(r.status, 12);
});

// ---------- unknown command exits 14 ----------

test('unknown action exits 14', () => {
  const r = runCli([line({ opId: 'a', action: 'HOLD', amount: 1 })]);
  assert.equal(r.status, 14);
});

test('dangling depends reference exits 14', () => {
  const r = runCli([line({ opId: 'a', action: 'FREEZE', amount: 1, depends: ['ghost'] })]);
  assert.equal(r.status, 14);
});

test('malformed JSON line exits 14', () => {
  const r = runCli(['{"opId":"a",']);
  assert.equal(r.status, 14);
});

test('duplicate opId exits 14', () => {
  const r = runCli([
    line({ opId: 'a', action: 'FREEZE', amount: 1 }),
    line({ opId: 'a', action: 'FREEZE', amount: 2 }),
  ]);
  assert.equal(r.status, 14);
});

// ---------- SETTLE / RELEASE rules ----------

test('SETTLE before any FREEZE on the account is UNSAT', () => {
  const commands = [cmd({ opId: 't', action: 'SETTLE', amount: 1, balance: 100 })];
  const out = judge(commands);
  assert.equal(out.result, 'UNSAT');
  assert.deepEqual(out.conflict, ['t']);
});

test('RELEASE exceeding frozen amount is UNSAT', () => {
  const commands = [
    cmd({ opId: 'f', action: 'FREEZE', amount: 3, balance: 10 }),
    cmd({ opId: 'r', action: 'RELEASE', amount: 4 }),
  ];
  const out = judge(commands);
  assert.equal(out.result, 'UNSAT');
  assert.deepEqual(out.conflict, ['r']);
});

test('RELEASE returns funds to available', () => {
  const commands = [
    cmd({ opId: 'f1', action: 'FREEZE', amount: 8, balance: 10 }),
    cmd({ opId: 'r1', action: 'RELEASE', amount: 8 }),
    cmd({ opId: 'f2', action: 'FREEZE', amount: 10 }),
  ];
  // f2 needs the released funds back in available, so r1 must precede f2
  assert.deepEqual(solve(commands), ['f1', 'r1', 'f2']);
});

// ---------- minimal conflict: lexicographic tie-break ----------

test('minimal conflict picks lexicographically smallest among equal-size minima', () => {
  // Two independent singleton conflicts: 'b' (settle w/o freeze) and 'a' (settle w/o freeze)
  const commands = [
    cmd({ opId: 'b', action: 'SETTLE', amount: 1 }),
    cmd({ opId: 'a', action: 'SETTLE', amount: 1 }),
    cmd({ opId: 'ok', action: 'FREEZE', amount: 1, account: 'B', balance: 5 }),
  ];
  assert.deepEqual(minimalConflict(commands), ['a']);
});

// ---------- CLI: SAT/UNSAT exits and --explain ----------

test('CLI SAT exits 0 and writes explain file', () => {
  const r = runCli(
    [line({ opId: 'f', action: 'FREEZE', amount: 2, balance: 5 })],
    { explain: true },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^SAT witness: f$/);
  assert.deepEqual(r.explain, { result: 'SAT', witness: ['f'] });
});

test('CLI UNSAT exits 1 and writes conflict to explain file', () => {
  const r = runCli([line({ opId: 't', action: 'SETTLE', amount: 1 })], { explain: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^UNSAT conflict: t$/);
  assert.deepEqual(r.explain, { result: 'UNSAT', conflict: ['t'] });
});

test('CLI error also records ERROR in explain file', () => {
  const r = runCli([line({ opId: 'a', action: 'BOGUS', amount: 1 })], { explain: true });
  assert.equal(r.status, 14);
  assert.equal(r.explain.result, 'ERROR');
  assert.equal(r.explain.code, 14);
});

// ---------- brute-force reference cross-check (n <= 8) ----------

test('brute force agrees with solver on crafted cases', () => {
  const cases = [
    [
      cmd({ opId: 'f1', action: 'FREEZE', amount: 50, balance: 100, start: 0, end: 2 }),
      cmd({ opId: 'd1', action: 'DEBIT', amount: 30, start: 1, end: 3 }),
      cmd({ opId: 'r1', action: 'RELEASE', amount: 10, start: 2, end: 4 }),
      cmd({ opId: 't1', action: 'SETTLE', amount: 10, start: 3, end: 5, depends: ['f1'] }),
    ],
    [
      cmd({ opId: 'a', action: 'DEBIT', amount: 5 }),
      cmd({ opId: 'b', action: 'FREEZE', amount: 5, balance: 5 }),
    ],
    [
      cmd({ opId: 'x', action: 'SETTLE', amount: 1 }),
      cmd({ opId: 'y', action: 'FREEZE', amount: 2, balance: 1 }),
    ],
  ];
  for (const commands of cases) {
    assert.deepEqual(solve(commands), bruteForce(commands));
  }
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHistory(rand, n) {
  const accounts = ['A', 'B'];
  const actions = ['FREEZE', 'DEBIT', 'RELEASE', 'SETTLE'];
  const commands = [];
  const balanceGiven = new Set();
  for (let i = 0; i < n; i++) {
    const account = accounts[Math.floor(rand() * accounts.length)];
    const start = Math.floor(rand() * 6);
    const end = start + Math.floor(rand() * 4);
    const c = cmd({
      opId: `op${i}`,
      action: actions[Math.floor(rand() * actions.length)],
      account,
      amount: 1 + Math.floor(rand() * 5),
      start,
      end,
    });
    if (!balanceGiven.has(account) && rand() < 0.6) {
      c.balance = Math.floor(rand() * 8);
      balanceGiven.add(account);
    }
    // acyclic depends: only reference earlier ops
    const deps = [];
    for (let j = 0; j < i; j++) {
      if (rand() < 0.15) deps.push(`op${j}`);
    }
    c.depends = deps;
    commands.push(c);
  }
  return commands;
}

test('randomized cross-check: solve() matches bruteForce() for n<=8', () => {
  const rand = mulberry32(20261003);
  for (let trial = 0; trial < 250; trial++) {
    const n = 1 + Math.floor(rand() * 7);
    const commands = randomHistory(rand, n);
    const expected = bruteForce(commands);
    const actual = solve(commands);
    assert.deepEqual(
      actual,
      expected,
      `mismatch on trial ${trial}: ${JSON.stringify(commands)}`,
    );
  }
});

test('randomized: judge() SAT/UNSAT agrees with brute force; conflict is minimal', () => {
  const rand = mulberry32(777);
  for (let trial = 0; trial < 150; trial++) {
    const n = 1 + Math.floor(rand() * 6);
    const commands = randomHistory(rand, n);
    const out = judge(commands);
    const ref = bruteForce(commands);
    if (ref !== null) {
      assert.equal(out.result, 'SAT', `trial ${trial}`);
      assert.deepEqual(out.witness, ref);
    } else {
      assert.equal(out.result, 'UNSAT', `trial ${trial}`);
      const byId = new Map(commands.map((c) => [c.opId, c]));
      const conflictCmds = out.conflict.map((id) => {
        const c = byId.get(id);
        const members = new Set(out.conflict);
        return { ...c, depends: c.depends.filter((d) => members.has(d)) };
      });
      const balances = accountBalances(commands);
      assert.equal(solve(conflictCmds, balances), null, `trial ${trial}: conflict is SAT`);
      for (const id of out.conflict) {
        const rest = conflictCmds.filter((c) => c.opId !== id);
        assert.notEqual(solve(rest, balances), null, `trial ${trial}: conflict not minimal at ${id}`);
      }
    }
  }
});

test('brute-force reference at n=8 agrees with solver', () => {
  const commands = [
    cmd({ opId: 'a', action: 'FREEZE', amount: 4, balance: 10, start: 0, end: 1 }),
    cmd({ opId: 'b', action: 'FREEZE', amount: 3, account: 'B', balance: 5, start: 0, end: 2 }),
    cmd({ opId: 'c', action: 'DEBIT', amount: 2, start: 1, end: 3 }),
    cmd({ opId: 'd', action: 'RELEASE', amount: 1, start: 2, end: 4 }),
    cmd({ opId: 'e', action: 'SETTLE', amount: 1, account: 'B', start: 3, end: 5, depends: ['b'] }),
    cmd({ opId: 'f', action: 'DEBIT', amount: 1, account: 'B', start: 3, end: 6 }),
    cmd({ opId: 'g', action: 'FREEZE', amount: 2, start: 4, end: 7 }),
    cmd({ opId: 'h', action: 'SETTLE', amount: 2, start: 5, end: 8, depends: ['g'] }),
  ];
  assert.equal(commands.length, 8);
  const expected = bruteForce(commands);
  assert.notEqual(expected, null);
  assert.deepEqual(solve(commands), expected);
});
