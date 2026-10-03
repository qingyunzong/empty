import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, VM } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { ReferenceFolder } from '../reference/fold.js';

const DAY = '2026-10-03';
const EQ = 'CNE000000001';

function feed(vm, seq, text) {
  return vm.apply(compile(text), seq);
}

test('acceptance 1: amend chain A1 -> A2 -> cancel A2 falls back to A1', () => {
  const vm = new VM();
  feed(vm, 1, `deposit ${DAY} ${EQ} qty 100000 cash 10000000`);
  feed(vm, 2, `trade A v1 ${DAY} buy 1000 ${EQ} @ 10 gross fee 30`);
  const afterA1 = vm.state();
  assert.equal(afterA1.ledger[`${DAY}|${EQ}`].frozenCash, '10030');

  feed(vm, 3, `amend A v2 ${DAY} buy 1500 ${EQ} @ 10.5 gross fee 40`);
  assert.equal(vm.state().ledger[`${DAY}|${EQ}`].frozenCash, '15790');
  assert.equal(vm.state().scopes[DAY].A.effective.version, 2);

  feed(vm, 4, `cancel A v2 ${DAY}`); // tombstone only; history not rewritten
  const back = vm.state();
  assert.equal(back.scopes[DAY].A.effective.version, 1);
  assert.deepEqual(back.ledger, afterA1.ledger); // freeze exactly back to A1
  assert.deepEqual(back.scopes[DAY].A.tombstones, [2]);
});

test('acceptance 2: oversell freeze raises E_NEG and leaves state unchanged', () => {
  const vm = new VM();
  feed(vm, 1, `deposit ${DAY} ${EQ} qty 100 cash 1000000`);
  feed(vm, 2, `trade S v1 ${DAY} sell 60 ${EQ} @ 10 gross`);
  const before = vm.state();
  assert.throws(
    () => feed(vm, 3, `trade S2 v1 ${DAY} sell 50 ${EQ} @ 10 gross`),
    (e) => e.code === 'E_NEG',
  );
  assert.deepEqual(vm.state(), before); // rejected atomically
  // buy with insufficient cash is also E_NEG
  assert.throws(
    () => feed(vm, 4, `trade B v1 ${DAY} buy 99999999 ${EQ} @ 10 gross`),
    (e) => e.code === 'E_NEG',
  );
  assert.deepEqual(vm.state(), before);
  // seq 3/4 were not consumed by rejections; a valid event may reuse them
  feed(vm, 3, `trade S3 v1 ${DAY} sell 40 ${EQ} @ 10 gross`);
  assert.equal(vm.state().ledger[`${DAY}|${EQ}`].frozenQty, '100');
});

test('acceptance 3: replaying the same seq is idempotent', () => {
  const vm = new VM();
  feed(vm, 1, `deposit ${DAY} ${EQ} qty 100 cash 1000000`);
  feed(vm, 2, `trade A v1 ${DAY} buy 10 ${EQ} @ 10 gross`);
  const snap = vm.state();
  const r1 = feed(vm, 2, `trade A v1 ${DAY} buy 10 ${EQ} @ 10 gross`);
  assert.equal(r1.noop, true);
  const r2 = feed(vm, 1, `deposit ${DAY} ${EQ} qty 100 cash 1000000`);
  assert.equal(r2.noop, true); // replay of an older seq is fine too
  assert.deepEqual(vm.state(), snap);
  assert.throws(() => feed(vm, 2, `trade A v1 ${DAY} buy 20 ${EQ} @ 10 gross`),
    (e) => e.code === 'E_SEQ'); // same seq, different payload
});

// --- acceptance 4: randomized differential test vs independent reference ---

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateEvents(seed, count) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const dates = ['2026-10-05', '2026-10-06'];
  const isins = ['CNE000000001', 'CND000000001'];
  const events = [];
  let seq = 0;
  const nextSeq = () => { seq += 1; return seq; };
  const priceOf = (isin) => (isin.startsWith('CND') ? '99.5' : (5 + Math.floor(rnd() * 4500) / 100).toFixed(2));
  const modeOf = (isin) => (isin.startsWith('CND') ? 'net accrued 0.25' : 'gross');
  const feeOf = () => pick(['', ' fee 1.5', ' fee qty * price * 0.0003', ' fee (qty * price) / 10000 + 0.5']);

  for (const d of dates) {
    for (const i of isins) {
      events.push({ seq: nextSeq(), text: `deposit ${d} ${i} qty 100000 cash 5000000` });
    }
  }
  const tradeIds = { };
  let n = 0;
  while (events.length < count) {
    const d = pick(dates);
    const isin = pick(isins);
    const roll = rnd();
    const ids = Object.keys(tradeIds).filter((id) => tradeIds[id] === d);
    if (roll < 0.45 || ids.length === 0) {
      n += 1;
      const id = `T${n}`;
      const dir = pick(['buy', 'sell']);
      const qty = 1 + Math.floor(rnd() * 800);
      tradeIds[id] = d;
      events.push({ seq: nextSeq(), text: `trade ${id} v1 ${d} ${dir} ${qty} ${isin} @ ${priceOf(isin)} ${modeOf(isin)}${feeOf()}` });
    } else if (roll < 0.7) {
      const id = pick(ids);
      const ver = 2 + Math.floor(rnd() * 4);
      const dir = pick(['buy', 'sell']);
      const qty = 1 + Math.floor(rnd() * 800);
      events.push({ seq: nextSeq(), text: `amend ${id} v${ver} ${d} ${dir} ${qty} ${isin} @ ${priceOf(isin)} ${modeOf(isin)}${feeOf()}` });
    } else if (roll < 0.85) {
      const id = pick(ids);
      const ver = 1 + Math.floor(rnd() * 5); // may target future versions: pending tombstone
      events.push({ seq: nextSeq(), text: `cancel ${id} v${ver} ${d}` });
    } else if (roll < 0.9) {
      const id = pick(ids);
      const other = dates.find((x) => x !== d);
      events.push({ seq: nextSeq(), text: `amend ${id} v2 ${other} buy 10 ${isin} @ ${priceOf(isin)} ${modeOf(isin)}` }); // E_VERSION cross-date
    } else if (roll < 0.94) {
      events.push({ seq: nextSeq(), text: `amend NOPE v2 ${d} buy 10 ${isin} @ ${priceOf(isin)} ${modeOf(isin)}` }); // E_VERSION unknown
    } else if (roll < 0.97) {
      const qty = 500000 + Math.floor(rnd() * 500000); // way beyond holdings: E_NEG
      events.push({ seq: nextSeq(), text: `trade X${n}x v1 ${d} sell ${qty} ${isin} @ ${priceOf(isin)} ${modeOf(isin)}` });
    } else {
      // exact replay of a random earlier event: idempotent no-op
      const earlier = pick(events);
      events.push({ seq: earlier.seq, text: earlier.text });
    }
  }
  return events.slice(0, count);
}

test('acceptance 4: 200 random events, VM matches independent fold at every prefix', () => {
  const events = generateEvents(20261003, 200);
  const vm = new VM();
  const ref = new ReferenceFolder();
  const vmErrors = [];
  for (let i = 0; i < events.length; i += 1) {
    const { seq, text } = events[i];
    try {
      vm.apply(compile(text), seq);
    } catch (e) {
      vmErrors.push({ seq, code: e.code });
    }
    const r = ref.push(seq, text);
    if (!r.ok) {
      const vmErr = vmErrors[vmErrors.length - 1];
      assert.equal(vmErr?.seq, seq, `VM should reject seq ${seq} too`);
      assert.equal(vmErr.code, r.code, `same error code at seq ${seq}`);
    }
    assert.deepEqual(vm.state(), ref.state(), `state mismatch after prefix ${i + 1} (seq ${seq}: ${text})`);
  }
  assert.ok(vmErrors.length > 0, 'expected some rejected events in the random stream');
  assert.ok(events.length === 200);
});

// --- CLI end-to-end (in-process; bin/escrow.js is a thin wrapper over runCli) ---

test('cli: fold with --at reproduces every prefix state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'escrow-'));
  const file = join(dir, 'ticks.jsonl');
  const lines = [
    { seq: 1, text: `deposit ${DAY} ${EQ} qty 1000 cash 100000` },
    { seq: 2, text: `trade A v1 ${DAY} buy 100 ${EQ} @ 10 gross fee 5` },
    { seq: 3, text: `amend A v2 ${DAY} buy 120 ${EQ} @ 10 gross fee 5` },
    { seq: 4, text: `cancel A v2 ${DAY}` },
    { seq: 5, text: `trade B v1 ${DAY} sell 50 ${EQ} @ 10 gross` },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));

  const full = JSON.parse(runCli(['fold', file]).stdout);
  assert.equal(full.applied, 5);
  assert.equal(full.ledger[`${DAY}|${EQ}`].frozenCash, '1005');
  assert.equal(full.ledger[`${DAY}|${EQ}`].frozenQty, '50');
  assert.equal(full.scopes[DAY].A.effective.version, 1);

  for (let n = 1; n <= 5; n += 1) {
    const at = JSON.parse(runCli(['fold', file, '--at', String(n)]).stdout);
    const vm = new VM();
    for (const l of lines.slice(0, n)) vm.apply(compile(l.text), l.seq);
    assert.deepEqual(at.ledger, vm.state().ledger, `--at ${n} ledger`);
    assert.deepEqual(at.scopes, vm.state().scopes, `--at ${n} scopes`);
  }
});

test('cli: E_NEG exits 1 with JSON error on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'escrow-'));
  const file = join(dir, 'bad.jsonl');
  writeFileSync(file, [
    JSON.stringify({ seq: 1, text: `deposit ${DAY} ${EQ} qty 10 cash 100` }),
    JSON.stringify({ seq: 2, text: `trade S v1 ${DAY} sell 50 ${EQ} @ 10 gross` }),
  ].join('\n'));
  const r = runCli(['fold', file]);
  assert.equal(r.code, 1);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error, 'E_NEG');
  assert.equal(err.seq, 2);
});
