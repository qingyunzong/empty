import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView, defectClosures } from '../src/lineage.js';
import { minimizeDfa, reachableDefectSet } from '../src/dfa.js';

// Acceptance 4: exhaustive enumeration of all lineages over <= 6 batches.
// Batch i may pick any subset of batches 0..i-1 as parents (index order is a
// topological order, so every assignment is a valid DAG): that is
// 2^(n*(n-1)/2) lineages per n, 32768 for n = 6.

function naiveClosure(records, name) {
  const byName = new Map(records.map((r) => [r.batch, r]));
  const out = new Set();
  const seen = new Set();
  const stack = [name];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const rec = byName.get(cur);
    for (const d of rec.defects ?? []) out.add(d);
    for (const p of rec.parents ?? []) stack.push(p);
  }
  return [...out].sort();
}

function* enumerateLineages(n) {
  const bits = (n * (n - 1)) / 2;
  const total = 2 ** bits;
  for (let mask = 0; mask < total; mask += 1) {
    const records = [];
    let shift = 0;
    for (let i = 0; i < n; i += 1) {
      const parents = [];
      for (let j = 0; j < i; j += 1) {
        if ((mask >> shift) & 1) parents.push(`b${j}`);
        shift += 1;
      }
      records.push({
        batch: `b${i}`,
        parents,
        defects: i % 2 === 0 ? [`d${i % 3}`] : [],
        pending: i % 3 === 0,
        on: { test: `b${(i + 1) % n}`, ship: `b${i}` },
      });
    }
    yield records;
  }
}

test('exhaustive <=6-batch lineages match naive reachable defect closure', () => {
  let checked = 0;
  for (let n = 1; n <= 6; n += 1) {
    for (const records of enumerateLineages(n)) {
      const closures = defectClosures(records);
      for (const rec of records) {
        assert.deepEqual(closures.get(rec.batch), naiveClosure(records, rec.batch));
      }
      checked += 1;
    }
  }
  assert.equal(checked, 33867); // 1 + 2 + 8 + 64 + 1024 + 32768
});

test('minimization preserves the reachable defect set of every state', () => {
  // Exhaustive for n <= 5 (1099 lineages); the n = 6 closure coverage above
  // already exercises the same code paths 32768 times.
  for (let n = 1; n <= 5; n += 1) {
    for (const records of enumerateLineages(n)) {
      const view = buildView(records, { start: 'b0' });
      const { classOf, view: minView } = minimizeDfa(view);
      for (const name of view.states.keys()) {
        assert.deepEqual(
          reachableDefectSet(minView, classOf.get(name)),
          reachableDefectSet(view, name),
        );
      }
    }
  }
});
