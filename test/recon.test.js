'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'recon.js');
const BRUTE = path.join(ROOT, 'scripts', 'brute.js');

const LEDGER_HEADER = 'settle_date,account,serial_no,amount,currency';
const FEE_HEADER = 'settle_date,account,serial_no,fee,currency';

function mkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recon-test-'));
}

function writeCsv(dir, name, header, rows) {
  fs.writeFileSync(path.join(dir, name), [header, ...rows].join('\n') + '\n');
}

// Note: this sandbox swallows piped stderr of spawned processes, so the CLI
// is invoked through bash with stderr redirected to a file.
function runCli(dir, extra = []) {
  const out = path.join(dir, 'result.json');
  const plan = path.join(dir, 'plan.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const args = [CLI, '--dir', dir, '--out', out, '--explain', plan, ...extra]
    .map((a) => `'${a}'`)
    .join(' ');
  const res = spawnSync('bash', ['-c', `${process.execPath} ${args} 2>'${errFile}'`], { encoding: 'utf8' });
  return {
    status: res.status,
    stderr: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '',
    out: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null,
    plan: fs.existsSync(plan) ? fs.readFileSync(plan, 'utf8') : null,
  };
}

// Deterministic PRNG (LCG) for fixture generation.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const fmt = (cents) => (cents / 100).toFixed(2);

// ---------- Acceptance A: NULLs and duplicate keys ----------

test('A: NULL amounts never match, flagged isNull in feeDiff', () => {
  const dir = mkDir();
  writeCsv(dir, 'internal.csv', LEDGER_HEADER, [
    '2026-09-30,A1,S1,100.00,CNY',   // exact match
    '2026-09-30,A1,S2,NULL,CNY',     // NULL vs NULL -> diff, isNull
    '2026-09-30,A1,S3,50.00,CNY',    // NULL on bank side -> diff, isNull
    '2026-09-30,A1,S4,10.00,CNY',    // amount mismatch -> diff
    '2026-09-30,A1,S5,1.00,CNY',     // only internal
  ]);
  writeCsv(dir, 'bank.csv', LEDGER_HEADER, [
    '2026-09-30,A1,S1,100.00,CNY',
    '2026-09-30,A1,S2,NULL,CNY',
    '2026-09-30,A1,S3,NULL,CNY',
    '2026-09-30,A1,S4,10.50,CNY',
    '2026-09-30,A1,S6,2.00,CNY',     // only bank
  ]);
  writeCsv(dir, 'fee.csv', FEE_HEADER, [
    '2026-09-30,A1,S1,0.10,CNY',     // expected 0.10 -> no fee diff
    '2026-09-30,A1,S4,0.20,CNY',     // expected 0.01 -> fee diff 0.19
    '2026-09-30,A1,S2,NULL,CNY',     // NULL fee -> isNull fee diff
  ]);
  const r = runCli(dir);
  assert.equal(r.status, 0, r.stderr);

  assert.deepEqual(
    r.out.matched.map((m) => m.serialNo),
    ['S1']
  );
  assert.deepEqual(r.out.onlyInternal.map((m) => m.serialNo), ['S5']);
  assert.deepEqual(r.out.onlyBank.map((m) => m.serialNo), ['S6']);

  const amountDiffs = r.out.feeDiff.filter((d) => d.kind === 'amount');
  assert.deepEqual(amountDiffs.map((d) => d.serialNo), ['S2', 'S3', 'S4']);
  const s2 = amountDiffs.find((d) => d.serialNo === 'S2');
  assert.equal(s2.isNull, true);
  assert.equal(s2.diff, null);
  const s4 = amountDiffs.find((d) => d.serialNo === 'S4');
  assert.equal(s4.isNull, false);
  assert.equal(s4.diff, 0.5);

  const feeDiffs = r.out.feeDiff.filter((d) => d.kind === 'fee');
  assert.deepEqual(feeDiffs.map((d) => d.serialNo), ['S2', 'S4']);
  assert.equal(feeDiffs.find((d) => d.serialNo === 'S2').isNull, true);
  assert.equal(feeDiffs.find((d) => d.serialNo === 'S4').diff, 0.19);

  // Aggregation: CNY amount diffs -> entries 3, non-null 1 (avg ignores NULL)
  const cny = r.out.summary.byCurrency.CNY;
  assert.equal(cny.amountDiff.entries, 3);
  assert.equal(cny.amountDiff.nonNull, 1);
  assert.equal(cny.amountDiff.sum, 0.5);
  assert.equal(cny.amountDiff.avg, 0.5);
  assert.equal(cny.feeDiff.entries, 2);
  assert.equal(cny.feeDiff.nonNull, 1);
  assert.equal(cny.feeDiff.avg, 0.19);
});

test('A: duplicate key in one file -> E_AMBIGUOUS, exit != 0, stderr JSON', () => {
  const dir = mkDir();
  writeCsv(dir, 'internal.csv', LEDGER_HEADER, ['2026-09-30,A1,S1,1.00,CNY']);
  writeCsv(dir, 'bank.csv', LEDGER_HEADER, [
    '2026-09-30,A1,S1,1.00,CNY',
    '2026-09-30,A1,S1,2.00,CNY',
  ]);
  writeCsv(dir, 'fee.csv', FEE_HEADER, []);
  const r = runCli(dir);
  assert.notEqual(r.status, 0);
  const err = JSON.parse(r.stderr.trim());
  assert.equal(err.code, 'E_AMBIGUOUS');
  assert.match(err.message, /S1/);
});

test('A: schema violations -> E_SCHEMA, exit != 0, stderr JSON', () => {
  for (const [name, files] of [
    ['bad header', { 'bank.csv': 'wrong,header\n1,2\n' }],
    ['bad amount', { 'bank.csv': LEDGER_HEADER + '\n2026-09-30,A1,S1,abc,CNY\n' }],
    ['bad date', { 'internal.csv': LEDGER_HEADER + '\n30/09/2026,A1,S1,1.00,CNY\n' }],
    ['missing file', { 'fee.csv': null }],
  ]) {
    const dir = mkDir();
    writeCsv(dir, 'internal.csv', LEDGER_HEADER, ['2026-09-30,A1,S1,1.00,CNY']);
    writeCsv(dir, 'bank.csv', LEDGER_HEADER, ['2026-09-30,A1,S1,1.00,CNY']);
    writeCsv(dir, 'fee.csv', FEE_HEADER, []);
    for (const [file, content] of Object.entries(files)) {
      const p = path.join(dir, file);
      if (content === null) fs.rmSync(p);
      else fs.writeFileSync(p, content);
    }
    const r = runCli(dir);
    assert.notEqual(r.status, 0, name);
    const err = JSON.parse(r.stderr.trim());
    assert.equal(err.code, 'E_SCHEMA', name);
    assert.ok(typeof err.message === 'string' && err.message.length > 0, name);
  }
});

// ---------- Acceptance B: index on/off identical results, different plans ----------

test('B: index on/off produce identical results but different plans', () => {
  const dir = mkDir();
  const rand = lcg(42);
  const internal = [];
  const bank = [];
  const fee = [];
  for (let i = 1; i <= 60; i++) {
    const row = `2026-09-${String(1 + (i % 28)).padStart(2, '0')},A${i % 5},S${String(i).padStart(4, '0')}`;
    const amt = Math.floor(rand() * 100000);
    internal.push(`${row},${rand() < 0.1 ? 'NULL' : fmt(amt)},${i % 2 ? 'CNY' : 'USD'}`);
    if (rand() < 0.8) bank.push(`${row},${rand() < 0.7 ? fmt(amt) : fmt(amt + 50)},${i % 2 ? 'CNY' : 'USD'}`);
    if (rand() < 0.6) fee.push(`${row},${fmt(Math.round(amt / 1000) + (rand() < 0.5 ? 0 : 7))},${i % 2 ? 'CNY' : 'USD'}`);
  }
  bank.push('2026-09-01,A9,S9999,3.14,USD');
  writeCsv(dir, 'internal.csv', LEDGER_HEADER, internal);
  writeCsv(dir, 'bank.csv', LEDGER_HEADER, bank);
  writeCsv(dir, 'fee.csv', FEE_HEADER, fee);

  const withIndex = runCli(dir);
  const withoutIndex = runCli(dir, ['--no-index']);
  assert.equal(withIndex.status, 0, withIndex.stderr);
  assert.equal(withoutIndex.status, 0, withoutIndex.stderr);
  assert.deepEqual(withoutIndex.out, withIndex.out);
  assert.notEqual(withoutIndex.plan, withIndex.plan);
  assert.match(withIndex.plan, /hash-join/);
  assert.match(withoutIndex.plan, /nested-loop/);
  assert.match(withIndex.plan, /Join order:/);
  assert.match(withIndex.plan, /Rationale:/);
});

// ---------- Acceptance C: 100-row cross-check vs independent script ----------

test('C: 100-row fixture matches independent brute-force script', () => {
  const dir = mkDir();
  const rand = lcg(20260930);
  const internal = [];
  const bank = [];
  const fee = [];
  const ccyOf = (i) => (i % 3 === 0 ? 'USD' : 'CNY');
  for (let i = 1; i <= 100; i++) {
    const key = `2026-09-${String(1 + (i % 28)).padStart(2, '0')},A${i % 7},S${String(i).padStart(4, '0')}`;
    const amt = Math.floor(rand() * 500000);
    const ccy = ccyOf(i);
    internal.push(`${key},${rand() < 0.08 ? 'NULL' : fmt(amt)},${ccy}`);
    const r = rand();
    if (r < 0.75) {
      const bankAmt = rand() < 0.7 ? amt : amt + Math.floor(rand() * 200) - 100;
      bank.push(`${key},${rand() < 0.08 ? 'NULL' : fmt(bankAmt)},${rand() < 0.05 ? (ccy === 'CNY' ? 'USD' : 'CNY') : ccy}`);
    }
    if (rand() < 0.7) {
      const expected = Math.round((amt * 10) / 10000);
      const actual = rand() < 0.6 ? expected : expected + Math.floor(rand() * 20) - 10;
      fee.push(`${key},${rand() < 0.06 ? 'NULL' : fmt(actual)},${ccy}`);
    }
  }
  for (let i = 101; i <= 108; i++) {
    bank.push(`2026-09-15,A${i % 7},S${String(i).padStart(4, '0')},${fmt(Math.floor(rand() * 10000))},${ccyOf(i)}`);
  }
  writeCsv(dir, 'internal.csv', LEDGER_HEADER, internal);
  writeCsv(dir, 'bank.csv', LEDGER_HEADER, bank);
  writeCsv(dir, 'fee.csv', FEE_HEADER, fee);

  const cli = runCli(dir);
  assert.equal(cli.status, 0, cli.stderr);
  const bruteOut = path.join(dir, 'brute.json');
  const brute = spawnSync('bash', ['-c', `${process.execPath} '${BRUTE}' --dir '${dir}' > '${bruteOut}'`], {
    encoding: 'utf8',
  });
  assert.equal(brute.status, 0);
  assert.deepEqual(cli.out, JSON.parse(fs.readFileSync(bruteOut, 'utf8')));
  const amountDiffKeys = cli.out.feeDiff.filter((d) => d.kind === 'amount').length;
  assert.equal(cli.out.matched.length + amountDiffKeys + cli.out.onlyInternal.length, 100);
});

// ---------- Acceptance D: empty bank file ----------

test('D: empty bank file (header only) -> all internal rows onlyInternal', () => {
  const dir = mkDir();
  writeCsv(dir, 'internal.csv', LEDGER_HEADER, [
    '2026-09-30,A1,S1,100.00,CNY',
    '2026-09-30,A2,S2,NULL,USD',
  ]);
  writeCsv(dir, 'bank.csv', LEDGER_HEADER, []);
  writeCsv(dir, 'fee.csv', FEE_HEADER, ['2026-09-30,A1,S1,0.10,CNY']);
  const r = runCli(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.matched.length, 0);
  assert.equal(r.out.onlyBank.length, 0);
  assert.equal(r.out.onlyInternal.length, 2);
  assert.equal(r.out.onlyInternal[1].amount, null);
  assert.equal(r.out.feeDiff.length, 0);
  assert.deepEqual(r.out.summary.byCurrency, {});
});

test('D: empty internal and empty bank -> all outputs empty', () => {
  const dir = mkDir();
  writeCsv(dir, 'internal.csv', LEDGER_HEADER, []);
  writeCsv(dir, 'bank.csv', LEDGER_HEADER, []);
  writeCsv(dir, 'fee.csv', FEE_HEADER, []);
  const r = runCli(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.matched, []);
  assert.deepEqual(r.out.onlyInternal, []);
  assert.deepEqual(r.out.onlyBank, []);
  assert.deepEqual(r.out.feeDiff, []);
});
