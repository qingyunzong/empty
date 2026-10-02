import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCausalGraph, minimalExplanations, explain } from '../src/explain.js';
import { snapOf, lcg } from '../testkit/helpers.js';

// Independent naive reference: enumerate all candidate subsets by
// increasing size and collect every minimum cover. Used to cross-check
// the optimized solver in src/explain.js.
function bruteForceMinExplanations(graph) {
  const { edges, params, diffRows } = graph;
  const reachCache = new Map();
  const reach = (start) => {
    if (!reachCache.has(start)) {
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) {
        for (const n of edges.get(stack.pop()) ?? []) {
          if (!seen.has(n)) { seen.add(n); stack.push(n); }
        }
      }
      reachCache.set(start, seen);
    }
    return reachCache.get(start);
  };
  const candidates = [...params, ...diffRows];
  const covers = (set) => diffRows.every((d) => set.some((c) => reach(c).has(d)));
  for (let k = 0; k <= candidates.length; k += 1) {
    const sols = [];
    const combo = [];
    const visit = (start) => {
      if (combo.length === k) {
        if (covers(combo)) sols.push([...combo].sort());
        return;
      }
      for (let i = start; i < candidates.length; i += 1) {
        combo.push(candidates[i]);
        visit(i + 1);
        combo.pop();
      }
    };
    visit(0);
    if (sols.length) return sols;
  }
  return [[]];
}

function graphFor({ params, tables }) {
  // tables: { name: { dependsOn: [...], refs: {...}, diffKeys: [...] } }
  const diff = { params: params.map((p) => ({ path: p, a: 0, b: 1 })), tables: {} };
  const schemaTables = {};
  const snapTables = {};
  for (const [name, t] of Object.entries(tables)) {
    diff.tables[name] = {
      onlyInA: [], onlyInB: [],
      changed: t.diffKeys.map((key) => ({ key, cells: [{ col: 'v', a: 0, b: 1 }] })),
      undecided: [], missingColumns: { onlyInA: [], onlyInB: [] },
    };
    schemaTables[name] = { key: ['id'], dependsOn: t.dependsOn ?? [], refs: t.refs ?? {} };
    const rows = (t.rows ?? t.diffKeys.map((k) => [k, 'F0']));
    snapTables[name] = { columns: t.columns ?? ['id', 'v'], key: ['id'], rows };
  }
  const snapA = snapOf({ name: 'a', tables: snapTables, schema: { tables: schemaTables } });
  const snapB = snapOf({ name: 'b', tables: snapTables, schema: { tables: schemaTables } });
  return buildCausalGraph(snapA, snapB, diff);
}

const sortAll = (sols) => sols.map((s) => [...s].sort()).sort();

test('200-row scenario: solver matches exhaustive subset enumeration', () => {
  // t1: 100 rows explained by p1 or p2; t2: 100 rows explained by p3 or p4.
  const tables = {
    t1: { dependsOn: ['p1', 'p2'], diffKeys: Array.from({ length: 100 }, (_, i) => `F${i + 1}`) },
    t2: { dependsOn: ['p3', 'p4'], diffKeys: Array.from({ length: 100 }, (_, i) => `F${i + 101}`) },
  };
  const graph = graphFor({ params: ['p1', 'p2', 'p3', 'p4'], tables });
  assert.equal(graph.diffRows.length, 200);
  const expected = bruteForceMinExplanations(graph);
  const actual = minimalExplanations(graph);
  assert.equal(expected.length, 4);
  assert.deepEqual(sortAll(actual), sortAll(expected));
  for (const sol of actual) assert.equal(sol.length, 2);
});

test('randomized 30-row scenarios: solver matches brute force (10 seeds)', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const rnd = lcg(seed);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const tables = {};
    const groups = [['p1', 'p2'], ['p2', 'p3'], ['p1', 'p3']];
    for (let t = 0; t < 3; t += 1) {
      const keys = [];
      for (let i = 0; i < 10; i += 1) keys.push(`F${t * 10 + i + 1}`);
      tables[`t${t}`] = { dependsOn: pick(groups), diffKeys: keys };
    }
    const graph = graphFor({ params: ['p1', 'p2', 'p3'], tables });
    const expected = bruteForceMinExplanations(graph);
    const actual = minimalExplanations(graph);
    assert.deepEqual(sortAll(actual), sortAll(expected), `seed ${seed}`);
  }
});

test('tied minimal explanations are all listed', () => {
  const graph = graphFor({
    params: ['p1', 'p2'],
    tables: { t: { dependsOn: ['p1', 'p2'], diffKeys: ['F1', 'F2', 'F3'] } },
  });
  const sols = minimalExplanations(graph);
  assert.deepEqual(sortAll(sols), sortAll([['param:p1'], ['param:p2']]));
});

test('forced rows (no explaining param) appear in every explanation', () => {
  const graph = graphFor({
    params: ['p1'],
    tables: {
      t1: { dependsOn: ['p1'], diffKeys: ['F1'] },
      t2: { dependsOn: [], diffKeys: ['F9'] },
    },
  });
  const sols = minimalExplanations(graph);
  assert.deepEqual(sortAll(sols), sortAll([
    ['param:p1', 'row:t2:F9'],
    ['row:t1:F1', 'row:t2:F9'],
  ]));
});

test('refs: differing referenced row explains referencing rows', () => {
  const graph = graphFor({
    params: [],
    tables: {
      t1: { diffKeys: ['F1'] },
      t2: {
        refs: { tid: 't1' },
        columns: ['id', 'tid'],
        diffKeys: ['F5', 'F6'],
        rows: [['F5', 'F1'], ['F6', 'F1']],
      },
    },
  });
  const sols = minimalExplanations(graph);
  assert.deepEqual(sols, [['row:t1:F1']]);
});

test('--one with tied minima raises E_AMBIG_MIN', () => {
  const schema = { tables: { t: { key: ['id'], dependsOn: ['p1', 'p2'], refs: {} } } };
  const tables = { t: { columns: ['id', 'v'], key: ['id'], rows: [['F1', 'F1']] } };
  const a = snapOf({ name: 'a', params: { p1: 1, p2: 1 }, tables, schema });
  const b = snapOf({ name: 'b', params: { p1: 2, p2: 2 }, tables: {
    t: { columns: ['id', 'v'], key: ['id'], rows: [['F1', 'F2']] } }, schema });
  assert.throws(() => explain(a, b, undefined, { one: true }), (e) => e.code === 'E_AMBIG_MIN');
  const all = explain(a, b);
  assert.equal(all.ambiguous, true);
  assert.equal(all.explanations.length, 3);
});
