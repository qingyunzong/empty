import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  analyze,
  canonicalStringify,
  minimize,
  reconcile,
  validateRecon,
  ReconError,
} from '../src/recon.js';

const normal = (entryId, amount, account = 'A') => ({ entryId, account, amount, type: 'normal' });
const reversal = (entryId, reversalOf, amount, account = 'A') => ({
  entryId,
  account,
  amount,
  type: 'reversal',
  reversalOf,
});

test('fully matched entries produce a balance certificate', () => {
  const result = analyze({
    expected: [normal('E1', 100), normal('E2', 50, 'B')],
    actual: [normal('E2', 50, 'B'), normal('E1', 100)],
  });
  assert.equal(result.status, 'BALANCED');
  assert.equal(result.certificate.balanced, true);
  assert.deepEqual(result.differences, []);
  assert.deepEqual(result.minimal, { expected: [], actual: [] });
  assert.match(result.replayHash, /^sha256:[0-9a-f]{64}$/);
});

test('reversal paired with its origin cancels out and stays balanced', () => {
  const result = analyze({
    expected: [normal('E1', 100), reversal('R1', 'E1', 100)],
    actual: [normal('E1', 100), reversal('R1', 'E1', 100)],
  });
  assert.equal(result.status, 'BALANCED');
});

test('missing, extra and amount-mismatch are classified with totals', () => {
  const result = analyze({
    expected: [normal('E1', 100), normal('E2', 40), normal('E3', 10, 'B')],
    actual: [normal('E1', 130), normal('E4', 7)],
  });
  const kinds = result.differences.map((d) => d.kind).sort();
  assert.deepEqual(kinds, ['amount-mismatch', 'extra', 'missing', 'missing']);
  const mismatch = result.differences.find((d) => d.kind === 'amount-mismatch');
  assert.equal(mismatch.entryId, 'E1');
  assert.equal(mismatch.expectedAmount, 100);
  assert.equal(mismatch.actualAmount, 130);
  const missingIds = result.differences.filter((d) => d.kind === 'missing').map((d) => d.entryId).sort();
  assert.deepEqual(missingIds, ['E2', 'E3']);
  assert.equal(result.totals.missingAmount, 50);
  assert.equal(result.totals.extraAmount, 7);
  assert.equal(result.totals.mismatchDelta, 30);
  assert.equal(result.totals.netImpact, 30 + 7 - 50);
});

test('orphan reversal is reported explicitly and cannot offset the missing origin', () => {
  const result = analyze({
    expected: [normal('E1', 100)],
    actual: [reversal('R1', 'E1', 100)],
  });
  assert.equal(result.status, 'UNBALANCED');
  const invalid = result.differences.find((d) => d.kind === 'invalid-reversal');
  assert.equal(invalid.reason, 'origin-missing');
  assert.equal(invalid.entryId, 'R1');
  assert.equal(invalid.side, 'actual');
  const missing = result.differences.find((d) => d.kind === 'missing');
  assert.equal(missing.entryId, 'E1');
});

test('mixed missing + reversal localizes both the origin and the reversal entries', () => {
  const result = analyze({
    expected: [normal('E1', 100), normal('E2', 50, 'B')],
    actual: [normal('E2', 50, 'B'), reversal('R1', 'E1', 100)],
  });
  assert.equal(result.status, 'UNBALANCED');
  const minimalIds = [
    ...result.minimal.expected.map((e) => `expected:${e.entryId}`),
    ...result.minimal.actual.map((e) => `actual:${e.entryId}`),
  ].sort();
  assert.deepEqual(minimalIds, ['actual:R1', 'expected:E1']);
  assert.equal(result.certificate.subsetSize, 2);
});

test('reversal with non-opposite amount is an invalid reversal, origin still matches', () => {
  const result = analyze({
    expected: [normal('E1', 100)],
    actual: [normal('E1', 100), reversal('R1', 'E1', 90)],
  });
  assert.deepEqual(result.differences.map((d) => d.kind), ['invalid-reversal']);
  assert.equal(result.differences[0].reason, 'amount-not-opposite');
  assert.equal(result.differences[0].originAmount, 100);
});

test('within-side reversal pair cancels; unmatched origin on the other side stays missing', () => {
  const result = analyze({
    expected: [normal('E1', 100)],
    actual: [normal('E1', 100), reversal('R1', 'E1', 100)],
  });
  assert.deepEqual(result.differences.map((d) => d.kind), ['missing']);
  assert.equal(result.differences[0].entryId, 'E1');
});

test('invalid input is rejected with INVALID_RECON', () => {
  const cases = [
    ['negative amount', { expected: [normal('E1', -5)], actual: [] }],
    ['duplicate id', { expected: [normal('E1', 5), normal('E1', 6)], actual: [] }],
    [
      'reversal chain',
      { expected: [], actual: [reversal('R1', 'E1', 5), reversal('R2', 'R1', 5)] },
    ],
    ['self reversal', { expected: [], actual: [reversal('R1', 'R1', 5)] }],
    ['normal with reversalOf', { expected: [{ ...normal('E1', 5), reversalOf: 'E0' }], actual: [] }],
    ['bad type', { expected: [{ entryId: 'E1', account: 'A', amount: 5, type: 'adjust' }], actual: [] }],
    ['missing reversalOf', { expected: [], actual: [{ entryId: 'R1', account: 'A', amount: 5, type: 'reversal' }] }],
    ['non array side', { expected: {}, actual: [] }],
  ];
  for (const [label, input] of cases) {
    assert.throws(() => validateRecon(input), (err) => {
      assert.equal(err.code, 'INVALID_RECON');
      assert.ok(err instanceof ReconError);
      return true;
    }, label);
  }
});

function* combos(count, size, start = 0, prefix = []) {
  if (size === 0) {
    yield prefix;
    return;
  }
  for (let i = start; i <= count - size; i += 1) {
    yield* combos(count, size - 1, i + 1, [...prefix, i]);
  }
}

// Independent re-implementation of the exhaustive minimizer used as an oracle.
function bruteForceMinimize(expected, actual) {
  const items = [
    ...expected.map((entry, index) => ({ side: 'expected', index, entry })),
    ...actual.map((entry, index) => ({ side: 'actual', index, entry })),
  ].sort((a, b) => {
    if (a.side !== b.side) return a.side < b.side ? -1 : 1;
    if (a.entry.entryId !== b.entry.entryId) return a.entry.entryId < b.entry.entryId ? -1 : 1;
    return a.index - b.index;
  });
  const target = canonicalStringify(reconcile(expected, actual).differences);
  for (let size = 1; size <= items.length; size += 1) {
    for (const combo of combos(items.length, size)) {
      const subExpected = [];
      const subActual = [];
      for (const i of combo) {
        (items[i].side === 'expected' ? subExpected : subActual).push(items[i].entry);
      }
      if (canonicalStringify(reconcile(subExpected, subActual).differences) === target) {
        return combo;
      }
    }
  }
  return [];
}

test('minimize matches independent subset enumeration for <=4 entries (fixed cases)', () => {
  const cases = [
    { expected: [normal('E1', 100)], actual: [reversal('R1', 'E1', 100)] },
    { expected: [normal('E1', 100), normal('E2', 50)], actual: [normal('E2', 50), reversal('R1', 'E1', 100)] },
    { expected: [normal('E1', 10)], actual: [normal('E1', 20)] },
    { expected: [normal('E1', 10), normal('E2', 20)], actual: [normal('E3', 30), normal('E4', 40)] },
    { expected: [], actual: [reversal('R1', 'ZZ', 5), normal('E1', 5)] },
    { expected: [normal('E1', 5), reversal('R1', 'E1', 7)], actual: [normal('E1', 5)] },
    { expected: [normal('E1', 5)], actual: [] },
    { expected: [], actual: [normal('E1', 5)] },
  ];
  for (const { expected, actual } of cases) {
    const reduction = minimize(expected, actual);
    assert.deepEqual(reduction.indices, bruteForceMinimize(expected, actual),
      `indices mismatch for ${canonicalStringify({ expected, actual })}`);
  }
});

function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('minimize matches independent subset enumeration for <=4 entries (fuzz)', () => {
  const rand = mulberry32(20261003);
  let compared = 0;
  let attempts = 0;
  while (compared < 300 && attempts < 5000) {
    attempts += 1;
    const count = 1 + Math.floor(rand() * 4);
    const templates = [];
    for (let i = 0; i < count; i += 1) {
      const amount = [5, 10, 20][Math.floor(rand() * 3)];
      const account = ['A', 'B'][Math.floor(rand() * 2)];
      if (rand() < 0.3 && i > 0) {
        const target = Math.floor(rand() * i);
        templates.push(reversal(`e${i}`, `e${target}`, amount, account));
      } else {
        templates.push(normal(`e${i}`, amount, account));
      }
    }
    const expected = [];
    const actual = [];
    for (const entry of templates) {
      const roll = rand();
      if (roll < 0.35) expected.push(entry);
      else if (roll < 0.7) actual.push(entry);
      else if (roll < 0.85) {
        expected.push(entry);
        actual.push(entry);
      }
    }
    let validated;
    try {
      validated = validateRecon({ expected, actual });
    } catch {
      continue; // skip inputs the validator rejects (e.g. generated chains)
    }
    const reduction = minimize(validated.expected, validated.actual);
    assert.deepEqual(
      reduction.indices,
      bruteForceMinimize(validated.expected, validated.actual),
      `seed case ${compared}: ${canonicalStringify(validated)}`,
    );
    compared += 1;
  }
  assert.equal(compared, 300);
});

test('greedy reduction on large input is one-minimal and reproduces the differences', () => {
  const expected = Array.from({ length: 7 }, (_, i) => normal(`E${i + 1}`, (i + 1) * 10));
  const actual = [
    ...Array.from({ length: 5 }, (_, i) => normal(`E${i + 1}`, (i + 1) * 10)),
    normal('X1', 99, 'B'),
  ];
  const full = reconcile(expected, actual);
  const reduction = minimize(expected, actual);
  assert.equal(reduction.algorithm, 'greedy-one-minimal');
  assert.equal(reduction.entryCount, 13);
  assert.equal(reduction.subsetSize, 3);
  const ids = [
    ...reduction.expected.map((e) => e.entryId),
    ...reduction.actual.map((e) => e.entryId),
  ].sort();
  assert.deepEqual(ids, ['E6', 'E7', 'X1']);
  // The reduced subset reproduces the full difference signature.
  const target = canonicalStringify(full.differences);
  assert.equal(
    canonicalStringify(reconcile(reduction.expected, reduction.actual).differences),
    target,
  );
  // Removing any single entry makes the discrepancy disappear (1-minimality).
  for (let i = 0; i < reduction.expected.length; i += 1) {
    const sub = reduction.expected.filter((_, j) => j !== i);
    assert.notEqual(canonicalStringify(reconcile(sub, reduction.actual).differences), target);
  }
  for (let i = 0; i < reduction.actual.length; i += 1) {
    const sub = reduction.actual.filter((_, j) => j !== i);
    assert.notEqual(canonicalStringify(reconcile(reduction.expected, sub).differences), target);
  }
});

test('replay hash is deterministic and recomputable', () => {
  const input = {
    expected: [normal('E1', 100), normal('E2', 50)],
    actual: [normal('E2', 50), reversal('R1', 'E1', 100)],
  };
  const first = analyze(input);
  const second = analyze(input);
  assert.equal(first.replayHash, second.replayHash);
  const recomputed = `sha256:${createHash('sha256')
    .update(canonicalStringify({
      differences: first.differences,
      minimal: first.minimal,
      totals: first.totals,
    }))
    .digest('hex')}`;
  assert.equal(first.replayHash, recomputed);
});
