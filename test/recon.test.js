import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = new URL('../bin/recon.js', import.meta.url).pathname;

function setup({ internal, bank, fee }) {
  const dir = mkdtempSync(join(tmpdir(), 'recon-'));
  writeFileSync(join(dir, 'internal.csv'), internal);
  writeFileSync(join(dir, 'bank.csv'), bank);
  writeFileSync(join(dir, 'fee.csv'), fee);
  return dir;
}

function run(dir, extra = []) {
  const out = join(dir, 'r.json');
  const explain = join(dir, 'plan.txt');
  // NB: this sandbox cannot pipe a grandchild's stderr (EPERM), so redirect
  // stderr to a file and read it back.
  const errFile = join(dir, 'stderr.txt');
  const errFd = openSync(errFile, 'w');
  const p = spawnSync(process.execPath, [BIN, '--dir', dir, '--out', out, '--explain', explain, ...extra], {
    stdio: ['ignore', 'pipe', errFd],
  });
  closeSync(errFd);
  const stderr = readFileSync(errFile, 'utf8');
  return {
    ...p,
    stderr,
    json: p.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null,
    plan: p.status === 0 ? readFileSync(explain, 'utf8') : null,
  };
}

const IH = 'date,account,txn_id,currency,amount,fee\n';
const BH = 'date,account,txn_id,currency,amount\n';
const FH = 'date,account,txn_id,currency,fee\n';

// Acceptance A: NULL amounts/fees and duplicate keys.
test('A: NULL semantics, matched/only/diff buckets, E_AMBIGUOUS on duplicates', () => {
  const dir = setup({
    internal:
      IH +
      '2026-09-30,A1,T1,CNY,100,1\n' + // matched
      '2026-09-30,A1,T2,CNY,,0.5\n' + // amount NULL vs 200 -> amountDiff isNull=left
      '2026-09-30,A1,T3,USD,50,\n' + // fee NULL vs NULL -> NOT equal (NULL!=NULL) -> feeDiff isNull=both
      '2026-09-30,A1,T4,CNY,7,0.1\n', // onlyInternal
    bank:
      BH +
      '2026-09-30,A1,T1,CNY,100\n' +
      '2026-09-30,A1,T2,CNY,200\n' +
      '2026-09-30,A1,T3,USD,50\n' +
      '2026-09-30,A1,T5,CNY,9\n', // onlyBank
    fee:
      FH +
      '2026-09-30,A1,T1,CNY,1\n' +
      '2026-09-30,A1,T2,CNY,0.5\n' +
      '2026-09-30,A1,T3,USD,\n',
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    const j = r.json;
    assert.deepEqual(j.matched.map((m) => m.txn_id), ['T1', 'T3']);
    assert.deepEqual(j.onlyInternal.map((m) => m.txn_id), ['T4']);
    assert.deepEqual(j.onlyBank.map((m) => m.txn_id), ['T5']);
    assert.equal(j.amountDiff.length, 1);
    assert.equal(j.amountDiff[0].txn_id, 'T2');
    assert.equal(j.amountDiff[0].internalAmount, null);
    assert.equal(j.amountDiff[0].bankAmount, 200);
    assert.equal(j.amountDiff[0].isNull, 'left');
    // NULL fee vs NULL fee: unknown -> not matched -> diff with isNull=both
    assert.equal(j.feeDiff.length, 1);
    assert.equal(j.feeDiff[0].txn_id, 'T3');
    assert.equal(j.feeDiff[0].isNull, 'both');
    // aggregation: CNY has one amountDiff (|null-200| skipped, NULL ignored in avg)
    const cny = j.summaryByCurrency.find((s) => s.currency === 'CNY');
    assert.equal(cny.diffCount, 1);
    assert.equal(cny.sumAbsDiff, 0);
    assert.equal(cny.avgAbsDiff, null); // avg ignores NULL -> no numeric pairs
    const usd = j.summaryByCurrency.find((s) => s.currency === 'USD');
    assert.equal(usd.diffCount, 1);
    assert.equal(usd.avgAbsDiff, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2: duplicate key in a source -> E_AMBIGUOUS, exit!=0, stderr JSON', () => {
  const dir = setup({
    internal: IH + '2026-09-30,A1,T1,CNY,1,0\n2026-09-30,A1,T1,CNY,2,0\n',
    bank: BH,
    fee: FH,
  });
  try {
    const r = run(dir);
    assert.notEqual(r.status, 0);
    const err = JSON.parse(r.stderr);
    assert.equal(err.code, 'E_AMBIGUOUS');
    assert.match(err.message, /T1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A3: schema violation -> E_SCHEMA, exit!=0, stderr JSON', () => {
  const dir = setup({
    internal: 'date,account,txn_id,currency\n2026-09-30,A1,T1,CNY\n',
    bank: BH,
    fee: FH,
  });
  try {
    const r = run(dir);
    assert.notEqual(r.status, 0);
    const err = JSON.parse(r.stderr);
    assert.equal(err.code, 'E_SCHEMA');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Acceptance B: index on/off -> identical results, different plans.
test('B: --no-index yields identical results but a different plan', () => {
  const dir = setup({
    internal:
      IH +
      '2026-09-30,A1,T1,CNY,100,1\n2026-09-30,A1,T2,CNY,,0.5\n2026-09-30,A2,T3,USD,50,2\n',
    bank: BH + '2026-09-30,A1,T1,CNY,100\n2026-09-30,A1,T2,CNY,200\n2026-09-30,A2,T4,USD,60\n',
    fee: FH + '2026-09-30,A1,T1,CNY,1\n2026-09-30,A2,T3,USD,1.5\n',
  });
  try {
    const withIdx = run(dir);
    const noIdx = run(dir, ['--no-index']);
    assert.equal(withIdx.status, 0);
    assert.equal(noIdx.status, 0);
    assert.deepEqual(noIdx.json, withIdx.json);
    assert.notEqual(noIdx.plan, withIdx.plan);
    assert.match(withIdx.plan, /HASH JOIN/);
    assert.match(noIdx.plan, /NESTED LOOP JOIN/);
    assert.match(withIdx.plan, /build hash index/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Acceptance C: 100-row fuzz vs an independent reference implementation.
test('C: 100 generated rows match independent reference script', () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const ccy = ['CNY', 'USD', 'EUR'];
  const amt = () => (rand() < 0.2 ? '' : (Math.floor(rand() * 10000) / 100).toFixed(2));
  const keys = [];
  for (let i = 0; i < 100; i++) keys.push(`2026-09-${String(1 + (i % 28)).padStart(2, '0')},A${i % 5},T${i}`);
  const internal = [], bank = [], fee = [];
  for (const k of keys) {
    const c = pick(ccy);
    const a = amt();
    internal.push(`${k},${c},${a},${amt()}`);
    if (rand() < 0.8) bank.push(`${k},${c},${rand() < 0.7 ? a : amt()}`);
    if (rand() < 0.8) fee.push(`${k},${c},${amt()}`);
  }
  const dir = setup({
    internal: IH + internal.join('\n') + '\n',
    bank: BH + bank.join('\n') + '\n',
    fee: FH + fee.join('\n') + '\n',
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);

    // Independent reference: plain object maps, no shared code with the CLI.
    const parse = (text) => {
      const [h, ...lines] = text.trim().split('\n');
      const cols = h.split(',');
      return lines.filter(Boolean).map((l) => {
        const v = l.split(',');
        const o = {};
        cols.forEach((c, i) => (o[c] = v[i] === '' ? null : v[i]));
        return o;
      });
    };
    const num = (x) => (x === null ? null : Number(x));
    const I = parse(readFileSync(join(dir, 'internal.csv'), 'utf8'));
    const B = parse(readFileSync(join(dir, 'bank.csv'), 'utf8'));
    const F = parse(readFileSync(join(dir, 'fee.csv'), 'utf8'));
    const key = (r) => `${r.date}|${r.account}|${r.txn_id}`;
    const bMap = new Map(B.map((r) => [key(r), r]));
    const iMap = new Map(I.map((r) => [key(r), r]));
    const fMap = new Map(F.map((r) => [key(r), r]));

    const expMatched = I.filter((r) => bMap.has(key(r)) && num(r.amount) !== null && num(bMap.get(key(r)).amount) !== null && num(r.amount) === num(bMap.get(key(r)).amount)).length;
    const expOnlyI = I.filter((r) => !bMap.has(key(r))).length;
    const expOnlyB = B.filter((r) => !iMap.has(key(r))).length;
    const expAmtDiff = I.filter((r) => {
      const b = bMap.get(key(r));
      if (!b) return false;
      const a1 = num(r.amount), a2 = num(b.amount);
      return a1 === null || a2 === null || a1 !== a2;
    }).length;
    const expFeeDiff = I.filter((r) => {
      const f = fMap.get(key(r));
      if (!f) return false;
      const f1 = num(r.fee), f2 = num(f.fee);
      return f1 === null || f2 === null || f1 !== f2;
    }).length;

    assert.equal(r.json.matched.length, expMatched);
    assert.equal(r.json.onlyInternal.length, expOnlyI);
    assert.equal(r.json.onlyBank.length, expOnlyB);
    assert.equal(r.json.amountDiff.length, expAmtDiff);
    assert.equal(r.json.feeDiff.length, expFeeDiff);
    // every matched row truly equal on amount
    for (const m of r.json.matched) {
      const b = bMap.get(`${m.date}|${m.account}|${m.txn_id}`);
      assert.equal(m.amount, num(b.amount));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Acceptance D: empty bank file (header only).
test('D: empty bank.csv -> everything onlyInternal, no matches', () => {
  const dir = setup({
    internal: IH + '2026-09-30,A1,T1,CNY,100,1\n2026-09-30,A1,T2,USD,,0.5\n',
    bank: BH,
    fee: FH + '2026-09-30,A1,T1,CNY,1\n',
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.matched.length, 0);
    assert.equal(r.json.onlyInternal.length, 2);
    assert.equal(r.json.onlyBank.length, 0);
    assert.equal(r.json.amountDiff.length, 0);
    assert.equal(r.json.feeDiff.length, 0);
    assert.match(r.plan, /0 rows|bank/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
