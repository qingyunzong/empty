import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRun, serializeRun } from '../src/fuzz.js';
import { replayRun } from '../src/replay.js';

test('same seed regenerates byte-identical run', () => {
  const a = serializeRun(generateRun({ seed: 42, steps: 80, accounts: 3 }));
  const b = serializeRun(generateRun({ seed: 42, steps: 80, accounts: 3 }));
  assert.equal(a, b);
});

test('different seeds diverge', () => {
  const a = generateRun({ seed: 1, steps: 40, accounts: 3 });
  const b = generateRun({ seed: 2, steps: 40, accounts: 3 });
  assert.notEqual(a.stateHash, b.stateHash);
  assert.notDeepEqual(a.randomSamples, b.randomSamples);
});

test('log records seed, seq, opId, rng samples and result per op', () => {
  const run = generateRun({ seed: 7, steps: 20, accounts: 2 });
  assert.equal(run.seed, 7);
  run.ops.forEach((entry, i) => {
    assert.equal(entry.seq, i);
    assert.equal(entry.opId, `op-${i}`);
    assert.ok(Array.isArray(entry.rng) && entry.rng.length > 0);
    assert.ok(entry.rng.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff));
    assert.ok(['ok', 'rejected'].includes(entry.result.status));
  });
  assert.deepEqual(
    run.ops.flatMap((o) => o.rng),
    run.randomSamples,
  );
});

test('acceptance seed 42/80/3 contains a cancel race and a business rejection', () => {
  const run = generateRun({ seed: 42, steps: 80, accounts: 3 });
  const cancelRaces = run.ops.filter(
    (o) => o.op.type === 'cancel' && o.result.status === 'rejected' && o.result.reason === 'hold_not_open',
  );
  const businessRejections = run.ops.filter(
    (o) =>
      o.result.status === 'rejected' &&
      (o.result.reason === 'insufficient_funds' || o.result.reason === 'account_frozen'),
  );
  assert.ok(cancelRaces.length >= 1, 'expected at least one cancel-after-close race');
  assert.ok(businessRejections.length >= 1, 'expected at least one business rejection');
});

test('replay of a generated run matches on all checks', () => {
  const run = generateRun({ seed: 42, steps: 80, accounts: 3 });
  const result = replayRun(JSON.parse(serializeRun(run)));
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, {
    randomSamples: true,
    ops: true,
    finalState: true,
    stateHash: true,
  });
});

test('replay detects tampering', () => {
  const run = JSON.parse(serializeRun(generateRun({ seed: 42, steps: 80, accounts: 3 })));
  run.ops[3].result = { status: 'ok' };
  const result = replayRun(run);
  assert.equal(result.ok, false);
  assert.equal(result.checks.ops, false);
});

test('invalid fuzz params are rejected with INVALID_INPUT', () => {
  for (const params of [
    { seed: 'abc', steps: 10, accounts: 3 },
    { seed: -1, steps: 10, accounts: 3 },
    { seed: 1.5, steps: 10, accounts: 3 },
    { seed: 42, steps: -1, accounts: 3 },
    { seed: 42, steps: 10, accounts: 0 },
  ]) {
    assert.throws(() => generateRun(params), (e) => e.code === 'INVALID_INPUT');
  }
});

test('unknown op type in run file is INVALID_INPUT', () => {
  const run = JSON.parse(serializeRun(generateRun({ seed: 42, steps: 5, accounts: 2 })));
  run.ops[0].op = { type: 'refund', amount: 1 };
  assert.throws(() => replayRun(run), (e) => e.code === 'INVALID_INPUT' && /unknown op type/.test(e.message));
});
