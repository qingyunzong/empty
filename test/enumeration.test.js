import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/graph.js';
import {
  makeState,
  applyTransactionRef,
  stateView,
  certificateOf,
} from './helpers/reference.js';

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPS = ['sum', 'min', 'max', 'avg', 'concat'];

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function randomValue(rand, numeric) {
  if (numeric) return Math.floor(rand() * 21) - 10;
  return pick(rand, ['x', 'y', 'zz', 'hello', '']);
}

// Build a random acyclic graph with <= 8 nodes. Edges only go from a lower
// index node to a higher index derived node, so it is acyclic by construction.
function randomGraph(rand) {
  const count = 2 + Math.floor(rand() * 7); // 2..8 nodes
  const numeric = rand() < 0.7; // mostly numeric graphs, some string graphs
  const nodes = [];
  for (let i = 0; i < count; i += 1) {
    const id = `n${i}`;
    if (rand() < 0.4 || i === 0) {
      nodes.push({ id, kind: 'source', value: randomValue(rand, numeric) });
    } else {
      nodes.push({ id, kind: 'derived', op: numeric ? pick(rand, OPS) : 'concat' });
    }
  }
  const edges = [];
  for (let to = 0; to < count; to += 1) {
    if (nodes[to].kind !== 'derived') continue;
    for (let from = 0; from < to; from += 1) {
      if (rand() < 0.35) edges.push({ from: nodes[from].id, to: nodes[to].id });
    }
  }
  return { nodes, edges, numeric };
}

function randomTransaction(rand, graph, index, recentTags) {
  const ops = [];
  const opCount = 1 + Math.floor(rand() * 3);
  const nodeIds = graph.nodes.map((n) => n.id);
  const sources = graph.nodes.filter((n) => n.kind === 'source').map((n) => n.id);
  const derived = graph.nodes.filter((n) => n.kind === 'derived').map((n) => n.id);
  for (let i = 0; i < opCount; i += 1) {
    const kind = rand();
    if (kind < 0.45 && sources.length > 0) {
      ops.push({
        type: 'setSource',
        node: pick(rand, sources),
        value: randomValue(rand, graph.numeric),
      });
    } else if (kind < 0.65 && derived.length > 0) {
      // Random edge attempt; may create a cycle on purpose sometimes.
      const from = pick(rand, nodeIds);
      const to = pick(rand, derived);
      ops.push({ type: 'addEdge', from, to });
    } else if (kind < 0.8 && graph.edges.length > 0) {
      const e = pick(rand, graph.edges);
      ops.push({ type: 'removeEdge', from: e.from, to: e.to });
    } else if (kind < 0.9 && recentTags.length > 0) {
      ops.push({ type: 'undo', tag: pick(rand, recentTags) });
    } else if (sources.length > 0) {
      ops.push({
        type: 'setSource',
        node: pick(rand, sources),
        value: randomValue(rand, graph.numeric),
      });
    }
  }
  if (ops.length === 0 && sources.length > 0) {
    ops.push({ type: 'setSource', node: sources[0], value: randomValue(rand, graph.numeric) });
  }
  const tx = { id: `tx${index}`, ops };
  if (rand() < 0.6) tx.undoTag = `u${Math.floor(rand() * 4)}`;
  return tx;
}

function sortedDiffs(diffs) {
  return [...diffs].sort((a, b) => a.node.localeCompare(b.node));
}

test('enumeration: incremental engine matches full-recompute reference (<=8 nodes)', () => {
  const SCENARIOS = 150;
  const TX_PER_SCENARIO = 12;
  for (let s = 0; s < SCENARIOS; s += 1) {
    const rand = rng(1000 + s);
    const graph = randomGraph(rand);
    const initial = { nodes: graph.nodes, edges: graph.edges };
    const engine = new Engine(initial);
    const ref = makeState(initial);
    const recentTags = [];
    for (let t = 0; t < TX_PER_SCENARIO; t += 1) {
      const tx = randomTransaction(rand, graph, t, recentTags);
      const got = engine.applyTransaction(tx);
      const expected = applyTransactionRef(ref, tx);
      assert.equal(
        got.status,
        expected.status,
        `scenario ${s} tx ${t} (${JSON.stringify(tx)}): status mismatch`,
      );
      if (got.status === 'error') {
        assert.equal(
          got.error.code,
          expected.error.code,
          `scenario ${s} tx ${t}: error code mismatch (${JSON.stringify(tx)})`,
        );
        // Rolled back: no partial effects, versions untouched.
        assert.deepEqual(engine.getState(), stateView(ref));
        continue;
      }
      if (tx.undoTag != null) recentTags.push(tx.undoTag);
      // 1) values: full state equality (nodes, edges, values, blocked, version)
      assert.deepEqual(
        engine.getState(),
        stateView(ref),
        `scenario ${s} tx ${t} (${JSON.stringify(tx)}): state mismatch`,
      );
      // 2) diff sets
      assert.deepEqual(
        sortedDiffs(got.diffs),
        sortedDiffs(expected.diffs),
        `scenario ${s} tx ${t}: diff set mismatch`,
      );
      // 3) version certificates
      assert.deepEqual(
        got.certificate,
        certificateOf(ref),
        `scenario ${s} tx ${t}: certificate mismatch`,
      );
    }
  }
});
