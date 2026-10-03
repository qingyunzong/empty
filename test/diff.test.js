import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDiffs,
  classifyDiffsReference,
  diffsToTasks,
  applyRepair,
  validateEntry,
} from '../src/diff.js';
import { ReconError } from '../src/errors.js';

const entry = (id, over = {}) => ({
  id,
  account: 'acct-1',
  day: '2026-10-03',
  merchant: 'm-1',
  amount: 100,
  currency: 'USD',
  ...over,
});

test('classifies missing_in_snapshot', () => {
  const diffs = classifyDiffs([entry('a')], []);
  assert.deepEqual(diffs.map((d) => d.kind), ['missing_in_snapshot']);
  assert.equal(diffs[0].id, 'a');
});

test('classifies missing_in_ledger', () => {
  const diffs = classifyDiffs([], [entry('a')]);
  assert.deepEqual(diffs.map((d) => d.kind), ['missing_in_ledger']);
});

test('classifies mismatch with exact fields', () => {
  const diffs = classifyDiffs([entry('a', { amount: 200, currency: 'EUR' })], [entry('a')]);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].kind, 'mismatch');
  assert.deepEqual(diffs[0].fields, ['amount', 'currency']);
});

test('classifies duplicates on both sides', () => {
  const diffs = classifyDiffs([entry('a'), entry('a')], [entry('b'), entry('b'), entry('b')]);
  const dup = diffs.filter((d) => d.kind === 'duplicate');
  assert.deepEqual(
    dup.map((d) => [d.id, d.side, d.occurrences]),
    [
      ['a', 'ledger', 2],
      ['b', 'snapshot', 3],
    ],
  );
});

test('matching entries produce no diffs', () => {
  assert.deepEqual(classifyDiffs([entry('a'), entry('b')], [entry('b'), entry('a')]), []);
});

test('invalid entries raise BAD_DIFF', () => {
  assert.throws(() => classifyDiffs([{ id: 'x' }], []), (e) => e instanceof ReconError && e.code === 'BAD_DIFF');
  assert.throws(() => validateEntry(entry('a', { amount: 1.5 }), 't'), /integer/);
  assert.throws(() => validateEntry(entry('a', { day: '10/03' }), 't'), /YYYY-MM-DD/);
});

test('applyRepair insert/remove/update/dedupe and BAD_DIFF cases', () => {
  const base = [entry('a'), entry('b')];
  const inserted = applyRepair(base, { action: 'insert', entry: entry('c') });
  assert.equal(inserted.length, 3);
  assert.equal(base.length, 2, 'applyRepair must not mutate the input');
  assert.throws(() => applyRepair(inserted, { action: 'insert', entry: entry('c') }), /BAD_DIFF|already present/);

  const removed = applyRepair(inserted, { action: 'remove', id: 'c' });
  assert.deepEqual(removed.map((e) => e.id), ['a', 'b']);
  assert.throws(() => applyRepair(removed, { action: 'remove', id: 'zz' }), /not present/);

  const updated = applyRepair(base, { action: 'update', id: 'a', set: { amount: 555 } });
  assert.equal(updated.find((e) => e.id === 'a').amount, 555);
  assert.throws(() => applyRepair(base, { action: 'update', id: 'zz', set: {} }), /not present/);

  const duped = [entry('a'), entry('a', { amount: 101 }), entry('b')];
  const deduped = applyRepair(duped, { action: 'dedupe', id: 'a' });
  assert.equal(deduped.filter((e) => e.id === 'a').length, 1);
  assert.throws(() => applyRepair(base, { action: 'dedupe', id: 'a' }), /occurrence/);
  assert.throws(() => applyRepair(base, { action: 'teleport' }), /unknown repair action/);
});

test('diffsToTasks maps kinds to repair actions with scheduling metadata', () => {
  const diffs = classifyDiffs(
    [entry('miss'), entry('mm', { amount: 300 })],
    [entry('mm'), entry('extra'), entry('extra')],
  );
  const tasks = diffsToTasks(diffs);
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  assert.equal(byId['repair:missing_in_snapshot:miss'].repair.action, 'insert');
  assert.equal(byId['repair:missing_in_ledger:extra'].repair.action, 'remove');
  assert.equal(byId['repair:mismatch:mm'].repair.action, 'update');
  assert.deepEqual(byId['repair:mismatch:mm'].repair.set, { amount: 300 });
  assert.equal(byId['repair:duplicate:extra'].repair.action, 'dedupe');
  assert.equal(byId['repair:mismatch:mm'].severity, 3);
  assert.equal(byId['repair:duplicate:extra'].severity, 1);
  assert.equal(byId['repair:mismatch:mm'].domain, 'acct-1@2026-10-03');
  assert.ok(tasks.every((t) => t.undoable));
});

// Deterministic PRNG so failures reproduce.
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

function randomEntries(rand, n) {
  const ids = ['a', 'b', 'c', 'd'];
  const accounts = ['acct-1', 'acct-2'];
  const merchants = ['m-1', 'm-2'];
  const days = ['2026-10-02', '2026-10-03'];
  const currencies = ['USD', 'EUR'];
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: pick(ids),
      account: pick(accounts),
      day: pick(days),
      merchant: pick(merchants),
      amount: Math.floor(rand() * 500),
      currency: pick(currencies),
    });
  }
  return out;
}

test('primary classifier matches reference classifier for n <= 8', () => {
  const ITERATIONS = 5000;
  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    const rand = mulberry32(iter * 2654435761 + 1);
    const nl = Math.floor(rand() * 9); // 0..8
    const ns = Math.floor(rand() * 9); // 0..8
    const ledger = randomEntries(rand, nl);
    const snapshot = randomEntries(rand, ns);
    const fast = classifyDiffs(ledger, snapshot);
    const slow = classifyDiffsReference(ledger, snapshot);
    assert.deepEqual(fast, slow, `divergence at iter=${iter} ledger=${JSON.stringify(ledger)} snapshot=${JSON.stringify(snapshot)}`);
  }
});
