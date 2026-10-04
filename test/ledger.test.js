import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LedgerError, tarjanSCC } from '../src/ledger.js';
import { run } from '../src/cli.js';

// --- independent reference implementations (used for cross-checking) ---

function bfsReachable(adj, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const u = queue.shift();
    for (const v of adj.get(u) ?? []) {
      if (!seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  return seen;
}

function kosarajuSCC(nodes, adj) {
  const visited = new Set();
  const order = [];
  const dfs1 = (u) => {
    visited.add(u);
    for (const v of adj.get(u) ?? []) if (!visited.has(v)) dfs1(v);
    order.push(u);
  };
  for (const u of nodes) if (!visited.has(u)) dfs1(u);
  const radj = new Map(nodes.map((n) => [n, []]));
  for (const [u, vs] of adj) for (const v of vs) radj.get(v).push(u);
  const seen = new Set();
  const comps = [];
  const dfs2 = (u, comp) => {
    seen.add(u);
    comp.push(u);
    for (const v of radj.get(u)) if (!seen.has(v)) dfs2(v, comp);
  };
  for (const u of [...order].reverse()) {
    if (!seen.has(u)) {
      const comp = [];
      dfs2(u, comp);
      comps.push(comp.sort());
    }
  }
  return comps;
}

const normalize = (comps) => comps.map((c) => [...c].sort()).sort().map((c) => c.join(','));
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// --- acceptance 1: cyclic guarantee network, SCC reversed as a group ---

test('cyclic guarantee network: SCC is reversed as a whole', () => {
  const ledger = new Ledger();
  ledger.addDep('a', 'b');
  ledger.addDep('b', 'c');
  ledger.addDep('c', 'a'); // SCC {a,b,c}
  ledger.addDep('d', 'a'); // d depends on the ring

  const res = ledger.cancel('evt-1', 'a');
  assert.deepEqual(res.affected, ['a', 'b', 'c']);

  const q = ledger.query();
  assert.deepEqual(q.affected, ['a', 'b', 'c']);
  assert.deepEqual(q.components, [
    { id: 'C0', members: ['a', 'b', 'c'] },
    { id: 'C1', members: ['d'] },
  ]);
  assert.deepEqual(q.topoOrder, ['C1', 'C0']); // d before its dependency
  assert.deepEqual(q.certificate.crossComponentEdges, [
    { from: 'd', to: 'a', fromComponent: 'C1', toComponent: 'C0' },
  ]);
  assert.ok(q.certificate.dfsEdges.length > 0);

  // Cancelling a member of the same SCC again is a duplicate.
  assert.throws(() => ledger.cancel('evt-2', 'b'), /already REVERSED/);
});

// --- acceptance 2: DAG, only reachable successors are reversed ---

test('DAG: cancel reverses exactly the reachable successors', () => {
  const ledger = new Ledger();
  ledger.addDep('a', 'b');
  ledger.addDep('b', 'c');
  ledger.addDep('a', 'c');
  ledger.addDep('d', 'e');

  const res = ledger.cancel('evt-1', 'a');
  assert.deepEqual(res.affected, ['a', 'b', 'c']);
  assert.deepEqual(ledger.query().affected, ['a', 'b', 'c']);

  // d and e form their own components and stay untouched.
  const q = ledger.query();
  assert.deepEqual(q.components.map((c) => c.members), [['a'], ['b'], ['c'], ['d'], ['e']]);
  assert.deepEqual(q.topoOrder, ['C0', 'C1', 'C2', 'C3', 'C4']);

  const res2 = ledger.cancel('evt-2', 'd');
  assert.deepEqual(res2.affected, ['d', 'e']);
});

// --- acceptance 3: remove-dep splits SCC, restore, error cases ---

test('remove-dep splits component; restore; unknown node / duplicate restore fail', () => {
  const ledger = new Ledger();
  ledger.addDep('a', 'b');
  ledger.addDep('b', 'a');
  ledger.addDep('b', 'c');
  ledger.addDep('c', 'b'); // single SCC {a,b,c}
  assert.deepEqual(ledger.query().components, [{ id: 'C0', members: ['a', 'b', 'c'] }]);

  const cancelled = ledger.cancel('evt-1', 'a');
  assert.deepEqual(cancelled.affected, ['a', 'b', 'c']);

  ledger.removeDep('b', 'c'); // splits {a,b,c} into {a,b} and {c}
  const q = ledger.query();
  assert.deepEqual(q.components, [
    { id: 'C0', members: ['a', 'b'] },
    { id: 'C1', members: ['c'] },
  ]);
  assert.deepEqual(q.topoOrder, ['C1', 'C0']); // c -> b, so c first
  assert.deepEqual(q.certificate.crossComponentEdges, [
    { from: 'c', to: 'b', fromComponent: 'C1', toComponent: 'C0' },
  ]);

  // restore from a only reaches {a,b}; c stays REVERSED.
  const restored = ledger.restore('evt-2', 'a');
  assert.deepEqual(restored.affected, ['a', 'b']);
  assert.deepEqual(ledger.query().affected, ['c']);

  // duplicate restore of a non-reversed transaction fails
  assert.throws(() => ledger.restore('evt-3', 'a'), (e) => e instanceof LedgerError && e.code === 'NOT_REVERSED');
  // unknown node fails for cancel, restore and remove-dep
  assert.throws(() => ledger.cancel('evt-4', 'zzz'), (e) => e.code === 'UNKNOWN_NODE');
  assert.throws(() => ledger.restore('evt-5', 'zzz'), (e) => e.code === 'UNKNOWN_NODE');
  assert.throws(() => ledger.removeDep('a', 'zzz'), (e) => e.code === 'UNKNOWN_NODE');
  assert.throws(() => ledger.removeDep('a', 'c'), (e) => e.code === 'UNKNOWN_DEP');
  // duplicate event id fails
  assert.throws(() => ledger.cancel('evt-1', 'c'), (e) => e.code === 'DUPLICATE_EVENT');

  // restore the remaining node
  const restored2 = ledger.restore('evt-6', 'c');
  assert.deepEqual(restored2.affected, ['c']);
  assert.deepEqual(ledger.query().affected, []);
});

// --- cross-check: n <= 8, enumeration reachable sets + Kosaraju ---

test('cross-check vs enumeration BFS and independent Kosaraju (n<=8)', () => {
  const rand = mulberry32(0xC0FFEE);
  for (let iter = 0; iter < 300; iter += 1) {
    const n = 1 + Math.floor(rand() * 8);
    const all = Array.from({ length: n }, (_, i) => `t${i}`);
    const p = 0.15 + rand() * 0.45;
    const edges = [];
    for (const u of all) {
      for (const v of all) {
        if (u !== v && rand() < p) edges.push([u, v]);
      }
    }
    // The ledger registers nodes via add-dep, so compare over nodes that
    // appear in at least one edge.
    const nodes = [...new Set(edges.flat())].sort();
    if (nodes.length === 0) continue;

    const ledger = new Ledger();
    const adj = new Map(nodes.map((x) => [x, new Set()]));
    for (const [u, v] of edges) {
      ledger.addDep(u, v);
      adj.get(u).add(v);
    }

    // SCC partition: Tarjan (library) vs Kosaraju (reference).
    const fromQuery = ledger.query().components.map((c) => c.members);
    assert.deepEqual(normalize(fromQuery), normalize(kosarajuSCC(nodes, adj)), `SCC mismatch iter=${iter}`);
    assert.deepEqual(normalize(tarjanSCC(nodes, adj)), normalize(kosarajuSCC(nodes, adj)));

    // Reachable set: library vs brute-force BFS enumeration.
    const tx = nodes[Math.floor(rand() * nodes.length)];
    const expected = [...bfsReachable(adj, tx)].sort();
    const res = ledger.cancel(`evt-${iter}`, tx);
    assert.deepEqual(res.affected, expected, `reachable mismatch iter=${iter}`);
    assert.deepEqual(ledger.query().affected, expected);

    // Reversal must be a union of whole SCCs.
    const compOf = new Map();
    fromQuery.forEach((comp, i) => comp.forEach((m) => compOf.set(m, i)));
    const touched = new Set(expected.map((m) => compOf.get(m)));
    for (const ci of touched) {
      for (const m of fromQuery[ci]) assert.ok(expected.includes(m), `partial SCC iter=${iter}`);
    }
  }
});

// --- certificate structure ---

test('certificate: DFS forest covers all nodes; cross edges match condensation', () => {
  const ledger = new Ledger();
  ledger.addDep('a', 'b');
  ledger.addDep('b', 'a');
  ledger.addDep('b', 'c');
  ledger.addDep('d', 'c');
  const q = ledger.query();

  // Deterministic DFS forest: a->b, b->c; d is a root with no new edges.
  assert.deepEqual(q.certificate.dfsEdges, [['a', 'b'], ['b', 'c']]);
  const targets = q.certificate.dfsEdges.map(([, v]) => v);
  assert.equal(new Set(targets).size, targets.length); // each node targeted at most once

  // Cross-component edges: exactly the inter-SCC edges of the graph.
  assert.deepEqual(q.certificate.crossComponentEdges, [
    { from: 'b', to: 'c', fromComponent: 'C0', toComponent: 'C1' },
    { from: 'd', to: 'c', fromComponent: 'C2', toComponent: 'C1' },
  ]);
  assert.deepEqual(q.topoOrder, ['C0', 'C2', 'C1']);
});

// --- CLI integration ---

function runCli(input) {
  const { results, exitCode } = run(input);
  return { code: exitCode, lines: results };
}

test('CLI: happy path exits 0 with per-line results', () => {
  const { code, lines } = runCli([
    '{"op":"add-dep","u":"a","v":"b"}',
    '{"op":"add-dep","u":"b","v":"a"}',
    '{"op":"cancel","id":"e1","tx":"a"}',
    '{"op":"query"}',
    '',
    '{"op":"restore","id":"e2","tx":"a"}',
    '{"op":"query"}',
  ].join('\n'));
  assert.equal(code, 0);
  assert.equal(lines.length, 6);
  assert.deepEqual(lines[2].affected, ['a', 'b']);
  assert.equal(lines[3].components.length, 1);
  assert.deepEqual(lines[4].affected, ['a', 'b']);
  assert.deepEqual(lines[5].affected, []);
});

test('CLI: error lines are JSON objects and exit code is 1', () => {
  const { code, lines } = runCli([
    '{"op":"add-dep","u":"a","v":"b"}',
    '{"op":"cancel","id":"e1","tx":"a"}',
    '{"op":"cancel","id":"e2","tx":"a"}',
    '{"op":"restore","id":"e3","tx":"ghost"}',
    'not json',
    '{"op":"query"}',
  ].join('\n'));
  assert.equal(code, 1);
  assert.equal(lines.length, 6);
  assert.equal(lines[2].ok, false);
  assert.equal(lines[2].error.code, 'DUPLICATE_CANCEL');
  assert.equal(lines[3].error.code, 'UNKNOWN_NODE');
  assert.equal(lines[4].error.code, 'INVALID_LINE');
  assert.equal(lines[5].ok, true); // processing continues after errors
});
