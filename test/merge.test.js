import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { decideField, mergeBranches, REASONS } from '../src/merge.js';
import { compareClocks } from '../src/vector-clock.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function branch(over = {}) {
  return {
    author: 'alice',
    sourceLevel: 1,
    vectorClock: { alice: 1 },
    changes: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Independent oracle: recomputes the expected per-field decision straight
// from the specification, without using the library's merge code.
// ---------------------------------------------------------------------------
function oracleDecide(field, baseValue, a, b) {
  if (!a && !b) return { decision: 'base', value: baseValue };
  if (a && !b) {
    if (a.old !== baseValue) return { decision: 'conflict', reason: 'stale-old-value' };
    return { decision: 'a', value: a.new };
  }
  if (!a && b) {
    if (b.old !== baseValue) return { decision: 'conflict', reason: 'stale-old-value' };
    return { decision: 'b', value: b.new };
  }
  if (a.new === b.new) return { decision: 'a', value: a.new };
  if (field === 'reviewed' && typeof a.new === 'boolean' && typeof b.new === 'boolean') {
    return { decision: 'conflict', reason: 'reviewed-divergent-booleans' };
  }
  if (a.old !== baseValue || b.old !== baseValue) {
    return { decision: 'conflict', reason: 'stale-old-value' };
  }
  if (a.sourceLevel !== b.sourceLevel) {
    const w = a.sourceLevel > b.sourceLevel ? a : b;
    return { decision: a.sourceLevel > b.sourceLevel ? 'a' : 'b', value: w.new };
  }
  const keys = new Set([...Object.keys(a.vectorClock), ...Object.keys(b.vectorClock)]);
  let aUp = false, bUp = false;
  for (const k of keys) {
    const av = a.vectorClock[k] ?? 0, bv = b.vectorClock[k] ?? 0;
    if (av > bv) aUp = true;
    if (av < bv) bUp = true;
  }
  if (!aUp && !bUp) return { decision: 'conflict', reason: 'equal-timestamp' };
  if (aUp && !bUp) return { decision: 'a', value: a.new };
  if (bUp && !aUp) return { decision: 'b', value: b.new };
  const w = a.author < b.author ? 'a' : 'b';
  return { decision: w, value: (w === 'a' ? a : b).new };
}

const CLOCKS = {
  'a-after-b': [{ x: 2, y: 1 }, { x: 1, y: 1 }],
  'b-after-a': [{ x: 1, y: 1 }, { x: 2, y: 3 }],
  concurrent: [{ x: 2 }, { y: 2 }],
  equal: [{ x: 1, y: 1 }, { x: 1, y: 1 }],
};

test('exhaustive single-field enumeration over finite domains', () => {
  const domain = [0, 1, 2];
  const sides = [null, ...domain]; // null = side did not change the field
  let checked = 0;
  for (const base of domain) {
    for (const aNew of sides) {
      for (const bNew of sides) {
        for (const levelA of [1, 2]) {
          for (const levelB of [1, 2]) {
            for (const rel of Object.keys(CLOCKS)) {
              const [clockA, clockB] = CLOCKS[rel];
              const a = aNew === null ? null : {
                old: base, new: aNew, author: 'alice', sourceLevel: levelA, vectorClock: clockA,
              };
              const b = bNew === null ? null : {
                old: base, new: bNew, author: 'bob', sourceLevel: levelB, vectorClock: clockB,
              };
              const expected = oracleDecide('value', base, a, b);
              const actual = decideField('value', base, a, b);
              assert.equal(actual.decision, expected.decision,
                `decision mismatch base=${base} a=${aNew} b=${bNew} lv=${levelA}/${levelB} ${rel}`);
              if (expected.decision !== 'conflict') {
                assert.deepEqual(actual.value, expected.value,
                  `value mismatch base=${base} a=${aNew} b=${bNew} lv=${levelA}/${levelB} ${rel}`);
              } else {
                assert.equal(actual.reason, expected.reason);
                assert.match(actual.certificate.sha256, /^[0-9a-f]{64}$/);
              }
              checked += 1;
            }
          }
        }
      }
    }
  }
  assert.equal(checked, 3 * 4 * 4 * 2 * 2 * 4);
});

test('exhaustive reviewed-field enumeration: divergent booleans always conflict', () => {
  const domain = [true, false];
  const sides = [null, ...domain];
  for (const base of domain) {
    for (const aNew of sides) {
      for (const bNew of sides) {
        for (const rel of Object.keys(CLOCKS)) {
          const [clockA, clockB] = CLOCKS[rel];
          const a = aNew === null ? null : {
            old: base, new: aNew, author: 'alice', sourceLevel: 2, vectorClock: clockA,
          };
          const b = bNew === null ? null : {
            old: base, new: bNew, author: 'bob', sourceLevel: 1, vectorClock: clockB,
          };
          const expected = oracleDecide('reviewed', base, a, b);
          const actual = decideField('reviewed', base, a, b);
          assert.equal(actual.decision, expected.decision,
            `reviewed base=${base} a=${aNew} b=${bNew} ${rel}`);
          if (aNew !== null && bNew !== null && aNew !== bNew) {
            assert.equal(actual.decision, 'conflict');
            assert.equal(actual.reason, REASONS.CONFLICT_REVIEWED);
          }
        }
      }
    }
  }
});

test('auto win: higher source level overrides lower', () => {
  const result = mergeBranches({
    base: { value: 10, quality: 'raw', reviewed: false },
    branchA: branch({
      author: 'sensor-hub', sourceLevel: 3, vectorClock: { 'sensor-hub': 1 },
      changes: { value: { old: 10, new: 11 } },
    }),
    branchB: branch({
      author: 'field-observer', sourceLevel: 1, vectorClock: { 'field-observer': 5 },
      changes: { value: { old: 10, new: 99 } },
    }),
  });
  assert.equal(result.status, 'merged');
  assert.equal(result.merged.value, 11);
  assert.equal(result.decisions.find((d) => d.field === 'value').reason, REASONS.LEVEL);
});

test('auto win: same level, newer vector timestamp wins', () => {
  const result = mergeBranches({
    base: { value: 1, quality: 'raw', reviewed: false },
    branchA: branch({ author: 'a', sourceLevel: 1, vectorClock: { a: 2 }, changes: { quality: { old: 'raw', new: 'clean' } } }),
    branchB: branch({ author: 'b', sourceLevel: 1, vectorClock: { a: 1 }, changes: { quality: { old: 'raw', new: 'suspect' } } }),
  });
  assert.equal(result.status, 'merged');
  assert.equal(result.merged.quality, 'clean');
  assert.equal(result.decisions.find((d) => d.field === 'quality').reason, REASONS.TIMESTAMP);
});

test('auto win: concurrent clocks resolved by author lexicographic order', () => {
  const result = mergeBranches({
    base: { value: 1, quality: 'raw', reviewed: false },
    branchA: branch({ author: 'alice', sourceLevel: 1, vectorClock: { alice: 1 }, changes: { value: { old: 1, new: 2 } } }),
    branchB: branch({ author: 'zoe', sourceLevel: 1, vectorClock: { zoe: 1 }, changes: { value: { old: 1, new: 3 } } }),
  });
  assert.equal(result.status, 'merged');
  assert.equal(result.merged.value, 2);
  assert.equal(result.decisions.find((d) => d.field === 'value').reason, REASONS.AUTHOR);
});

test('identical change on both sides merges without conflict', () => {
  const result = mergeBranches({
    base: { value: 1, quality: 'raw', reviewed: false },
    branchA: branch({ author: 'a', vectorClock: { a: 1 }, changes: { reviewed: { old: false, new: true } } }),
    branchB: branch({ author: 'b', vectorClock: { b: 1 }, changes: { reviewed: { old: false, new: true } } }),
  });
  assert.equal(result.status, 'merged');
  assert.equal(result.merged.reviewed, true);
  assert.equal(result.decisions.find((d) => d.field === 'reviewed').reason, REASONS.IDENTICAL);
});

test('conflict: exactly equal vector timestamps', () => {
  const result = mergeBranches({
    base: { value: 1, quality: 'raw', reviewed: false },
    branchA: branch({ author: 'a', sourceLevel: 1, vectorClock: { a: 1, b: 1 }, changes: { value: { old: 1, new: 2 } } }),
    branchB: branch({ author: 'b', sourceLevel: 1, vectorClock: { a: 1, b: 1 }, changes: { value: { old: 1, new: 3 } } }),
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.merged, null);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].reason, REASONS.CONFLICT_EQUAL_TIME);
  assert.equal(result.conflicts[0].field, 'value');
  assert.match(result.conflicts[0].sha256, /^[0-9a-f]{64}$/);
});

test('conflict: stale write whose old value does not match base', () => {
  const result = mergeBranches({
    base: { value: 10, quality: 'raw', reviewed: false },
    branchA: branch({ author: 'a', vectorClock: { a: 3 }, changes: { value: { old: 7, new: 12 } } }),
    branchB: branch({ author: 'b', vectorClock: { b: 1 }, changes: {} }),
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].reason, REASONS.CONFLICT_STALE);
  assert.equal(result.conflicts[0].a.old, 7);
  assert.equal(result.conflicts[0].baseValue, 10);
});

test('conflict: stale old value on one side of a divergent edit', () => {
  const result = mergeBranches({
    base: { value: 10, quality: 'raw', reviewed: false },
    branchA: branch({ author: 'a', sourceLevel: 2, vectorClock: { a: 3 }, changes: { value: { old: 10, new: 12 } } }),
    branchB: branch({ author: 'b', sourceLevel: 1, vectorClock: { b: 1 }, changes: { value: { old: 9, new: 20 } } }),
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].reason, REASONS.CONFLICT_STALE);
});

test('compareClocks relations', () => {
  assert.equal(compareClocks({ a: 1 }, { a: 1 }), 'equal');
  assert.equal(compareClocks({ a: 2, b: 1 }, { a: 1 }), 'a-after-b');
  assert.equal(compareClocks({ a: 1 }, { a: 1, b: 2 }), 'b-after-a');
  assert.equal(compareClocks({ a: 2 }, { b: 2 }), 'concurrent');
});

// ---------------------------------------------------------------------------
// CLI integration
// ---------------------------------------------------------------------------
function runCli(dir, base, branchA, branchB) {
  writeFileSync(join(dir, 'base.json'), JSON.stringify(base));
  writeFileSync(join(dir, 'a.json'), JSON.stringify(branchA));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(branchB));
  return spawnSync(process.execPath, [
    CLI, 'merge',
    '--base', join(dir, 'base.json'),
    '--a', join(dir, 'a.json'),
    '--b', join(dir, 'b.json'),
    '--out-dir', dir,
  ], { encoding: 'utf8' });
}

test('CLI: successful merge writes merged.json and decision-log.json, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-ok-'));
  const proc = runCli(
    dir,
    { value: 1, quality: 'raw', reviewed: false },
    branch({ author: 'a', sourceLevel: 2, vectorClock: { a: 1 }, changes: { value: { old: 1, new: 5 } } }),
    branch({ author: 'b', sourceLevel: 1, vectorClock: { b: 1 }, changes: { reviewed: { old: false, new: true } } }),
  );
  assert.equal(proc.status, 0, proc.stderr);
  const merged = JSON.parse(readFileSync(join(dir, 'merged.json'), 'utf8'));
  assert.deepEqual(merged, { value: 5, quality: 'raw', reviewed: true });
  const log = JSON.parse(readFileSync(join(dir, 'decision-log.json'), 'utf8'));
  assert.equal(log.status, 'merged');
  assert.equal(log.decisions.length, 3);
  assert.equal(existsSync(join(dir, 'conflicts.json')), false);
});

test('CLI: conflict writes certificate log and exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-conflict-'));
  const proc = runCli(
    dir,
    { value: 1, quality: 'raw', reviewed: false },
    branch({ author: 'a', sourceLevel: 1, vectorClock: { a: 1, b: 1 }, changes: { value: { old: 1, new: 2 } } }),
    branch({ author: 'b', sourceLevel: 1, vectorClock: { a: 1, b: 1 }, changes: { value: { old: 1, new: 3 } } }),
  );
  assert.equal(proc.status, 2, proc.stderr);
  assert.equal(existsSync(join(dir, 'merged.json')), false);
  const conflicts = JSON.parse(readFileSync(join(dir, 'conflicts.json'), 'utf8'));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, REASONS.CONFLICT_EQUAL_TIME);
  const log = JSON.parse(readFileSync(join(dir, 'decision-log.json'), 'utf8'));
  assert.equal(log.status, 'conflict');
});
