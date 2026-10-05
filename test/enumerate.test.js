import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistories, applyOrder, matrixToObject } from '../src/merge.js';
import { parseHistories, unwindUndos, pairSyncs, validateConfig } from '../src/history.js';
import { buildGraph, transitiveClosure, allTopoOrders } from '../src/graph.js';
import { Budget, ConflictError } from '../src/errors.js';
import { mulberry32 } from './helpers.js';

const DOMAIN_CONFIG = {
  species: [
    { id: 'S1', morph: 'forb' },
    { id: 'S2', morph: 'forb' },
  ],
  plots: [
    { id: 'P1', area: 50 },
    { id: 'P2', area: 50 },
    { id: 'P3', area: 50 },
  ],
  maxTier: 5,
};

// Random small histories (n <= 8 effective ops), plots partitioned across
// devices so merged application can never violate capacity; only set_count
// and paired syncs, so all legal serializations must converge.
function genCase(rand) {
  const devices = ['A', 'B', 'C'].slice(0, 2 + Math.floor(rand() * 2));
  const plotOf = { A: 'P1', B: 'P2', C: 'P3' };
  const n = 2 + Math.floor(rand() * 7); // 2..8 ops total
  const ts = Object.fromEntries(devices.map((d) => [d, 0]));
  const ops = [];
  let mark = 0;
  let uid = 0;
  while (ops.length < n) {
    const remaining = n - ops.length;
    const wantSync = remaining >= 2 && rand() < 0.35;
    if (wantSync) {
      const pair = [...devices].sort(() => rand() - 0.5).slice(0, 2);
      mark += 1;
      for (const d of pair) {
        ts[d] += 1;
        ops.push({ id: `o${uid++}`, device: d, ts: ts[d], op: 'sync', with: pair.find((x) => x !== d), mark: `m${mark}` });
      }
    } else {
      const d = devices[Math.floor(rand() * devices.length)];
      ts[d] += 1;
      ops.push({
        id: `o${uid++}`, device: d, ts: ts[d], op: 'set_count',
        plot: plotOf[d],
        species: rand() < 0.5 ? 'S1' : 'S2',
        tier: Math.floor(rand() * 6),
      });
    }
  }
  // group into per-device JSONL texts
  const inputs = devices.map((d) => ({
    name: d,
    text: ops.filter((o) => o.device === d).map((o) => JSON.stringify(o)).join('\n') + '\n',
  }));
  return inputs;
}

function enumerateSerializations(inputs) {
  const domain = validateConfig(DOMAIN_CONFIG);
  const eff = unwindUndos(parseHistories(inputs, domain));
  const pairs = pairSyncs(eff);
  const ops = [...eff.values()].flat();
  const opsById = new Map(ops.map((o) => [o.id, o]));
  const adj = buildGraph(ops, pairs);
  const budget = new Budget();
  const reach = transitiveClosure(adj, budget);
  const hb = (a, b) => reach.get(a)?.has(b) ?? false;
  const results = new Set();
  let count = 0;
  for (const order of allTopoOrders(adj)) {
    count += 1;
    results.add(JSON.stringify(matrixToObject(applyOrder(order, opsById, domain, [], hb))));
  }
  return { results, count };
}

test('acceptance 4: n<=8 merge result matches enumeration of all topological orders', () => {
  const rand = mulberry32(20261005);
  let decided = 0;
  let conflicts = 0;
  for (let t = 0; t < 80; t++) {
    const inputs = genCase(rand);
    let verdict = null;
    try {
      verdict = mergeHistories(DOMAIN_CONFIG, inputs);
    } catch (e) {
      assert.ok(e instanceof ConflictError, `trial ${t}: unexpected error ${e}`);
      conflicts += 1;
      continue; // cyclic or interfering histories are decided CONFLICT, not merged
    }
    decided += 1;
    const { results, count } = enumerateSerializations(inputs);
    assert.ok(count >= 1, `trial ${t}: at least one topological order exists`);
    assert.ok(
      results.has(JSON.stringify(verdict.matrix)),
      `trial ${t}: merged matrix must appear among all legal serializations`
    );
    assert.equal(
      results.size, 1,
      `trial ${t}: non-conflicting histories must converge to exactly one matrix`
    );
  }
  assert.ok(decided >= 30, `property test needs enough decided cases (got ${decided}, ${conflicts} conflicts)`);
});
