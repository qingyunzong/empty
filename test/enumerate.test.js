import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePool } from '../src/generate.js';
import { Model } from '../src/model.js';
import { enumerateSchedules } from '../src/enumerate.js';
import { bruteForceSchedules } from '../src/bruteforce.js';
import { buildReport } from '../src/report.js';

function statsFor(seed, accounts, tasks, options) {
  const pool = generatePool({ seed, accounts, tasks });
  const model = new Model(pool.accounts, pool.tasks, options);
  return { pool, stats: enumerateSchedules(model, options) };
}

test('seed 7 pool is safe and produces an enumeration certificate', () => {
  const { pool, stats } = statsFor(7, 3, 8);
  assert.equal(stats.safe, true);
  assert.equal(stats.violation, null);
  assert.ok(stats.scheduleCount > 0n);
  const report = buildReport(pool, stats);
  assert.ok(report.certificate);
  assert.equal(report.certificate.schedules, stats.scheduleCount.toString());
  assert.equal(report.certificate.invariant, 'used + frozen <= limit');
  assert.match(report.stateHash, /^[0-9a-f]{64}$/);
});

test('enumeration is deterministic across runs', () => {
  const first = statsFor(7, 3, 8);
  const second = statsFor(7, 3, 8);
  assert.equal(buildReport(first.pool, first.stats).stateHash, buildReport(second.pool, second.stats).stateHash);
  assert.equal(first.stats.scheduleCount, second.stats.scheduleCount);
});

test('main enumerator matches the independent full-permutation enumerator for <= 3 tasks', () => {
  for (const seed of [1, 2, 3, 7, 42]) {
    const pool = generatePool({ seed, accounts: 2, tasks: 3 });
    const main = new Model(pool.accounts, pool.tasks);
    const stats = enumerateSchedules(main, { collect: true });
    const reference = new Model(pool.accounts, pool.tasks);
    const expected = bruteForceSchedules(reference);
    const actual = new Set(stats.terminalPaths.map((p) => p.join(' ')));
    assert.deepEqual(actual, expected, `schedule set mismatch for seed ${seed}`);
    assert.equal(stats.scheduleCount, BigInt(expected.size));
  }
});

test('rigged model without limit enforcement yields the shortest lexicographic violation', () => {
  const accounts = [{ id: 'A0', limit: 5 }];
  const tasks = [
    { id: 'T0', kind: 'freeze', account: 0, amount: 3 },
    { id: 'T1', kind: 'debit', account: 0, amount: 3 },
  ];
  const model = new Model(accounts, tasks, { enforceLimit: false });
  const stats = enumerateSchedules(model);
  assert.equal(stats.safe, false);
  assert.deepEqual(stats.violation, ['T0:R', 'T1:R']);
});

test('certificate counts are consistent with a full collection run', () => {
  const { stats } = statsFor(11, 2, 3);
  const collected = statsFor(11, 2, 3, { collect: true });
  assert.equal(stats.scheduleCount, BigInt(collected.stats.terminalPaths.length));
});
