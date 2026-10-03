import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Monitor } from '../src/monitor.js';
import { parseLog } from '../src/wal.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- independent naive reference implementation (recompute from scratch) ---

function componentCount(vertices, edges) {
  const parent = new Map(vertices.map((v) => [v, v]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const [u, v] of edges) {
    const ru = find(u);
    const rv = find(v);
    if (ru !== rv) parent.set(ru, rv);
  }
  const roots = new Set(vertices.map(find));
  return roots.size;
}

function endpointsOf(edges) {
  const s = new Set();
  for (const [u, v] of edges) { s.add(u); s.add(v); }
  return [...s];
}

function naiveBridges(edges) {
  const vertices = endpointsOf(edges);
  const base = componentCount(vertices, edges);
  const out = [];
  for (let i = 0; i < edges.length; i += 1) {
    const rest = edges.filter((_, j) => j !== i);
    if (componentCount(vertices, rest) > base) {
      const [u, v] = edges[i];
      out.push(u < v ? [u, v] : [v, u]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function naiveArticulation(edges) {
  const vertices = endpointsOf(edges);
  const base = componentCount(vertices, edges);
  const out = [];
  for (const v of vertices) {
    const restV = vertices.filter((x) => x !== v);
    const restE = edges.filter(([a, b]) => a !== v && b !== v);
    if (componentCount(restV, restE) > base) out.push(v);
  }
  return out.sort((a, b) => a - b);
}

// --- randomized differential test: Tarjan vs naive, live vs replayed ---

test('random graphs (n<=10) with edge deletions: live results match naive recompute and log replay', () => {
  const TRIALS = 30;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const rnd = mulberry32(1000 + trial);
    const n = 2 + Math.floor(rnd() * 9); // 2..10 vertices
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-rnd-'));
    const log = path.join(dir, 'ops.jsonl');
    let m = new Monitor(log);
    const mirror = new Set(); // canonical "u,v" edge set
    const key = (u, v) => (u < v ? `${u},${v}` : `${v},${u}`);
    const mirrorEdges = () => [...mirror].map((k) => k.split(',').map(Number));

    const OPS = 120;
    for (let step = 0; step < OPS; step += 1) {
      const u = Math.floor(rnd() * n);
      let v = Math.floor(rnd() * n);
      if (u === v) v = (v + 1) % n;
      const k = key(u, v);
      if (mirror.has(k) && rnd() < 0.45) {
        assert.equal(m.delEdge(u, v), 'OK');
        mirror.delete(k);
      } else if (!mirror.has(k)) {
        assert.equal(m.addEdge(u, v), 'OK');
        mirror.add(k);
      } else {
        assert.equal(m.delEdge(u, v), 'OK'); // known edge, delete
        mirror.delete(k);
      }

      // cross-check Tarjan against the naive recomputation every step
      const edges = mirrorEdges();
      assert.deepEqual(m.queryBridges(), naiveBridges(edges), `bridges trial=${trial} step=${step}`);
      assert.deepEqual(m.queryArticulation(), naiveArticulation(edges), `articulation trial=${trial} step=${step}`);

      // periodically commit and verify replay-from-log equals the live view
      if (step % 25 === 24) {
        m.commit();
        const replayed = new Monitor(log);
        assert.deepEqual(replayed.queryBridges(), m.queryBridges());
        assert.deepEqual(replayed.queryArticulation(), m.queryArticulation());
        assert.equal(replayed.stateHash(), m.stateHash());
        m = replayed; // continue on top of the recovered instance
      }
    }
  }
});

test('random crash injection between operations keeps recovery deterministic', () => {
  const rnd = mulberry32(42);
  const points = ['after_append', 'before_fsync', 'after_index_commit'];
  for (let trial = 0; trial < 10; trial += 1) {
    const n = 2 + Math.floor(rnd() * 9);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-crash-'));
    const log = path.join(dir, 'ops.jsonl');
    const m = new Monitor(log);
    const current = new Set(); // mirrors the live edge set
    const key = (u, v) => (u < v ? `${u},${v}` : `${v},${u}`);
    for (let step = 0; step < 40; step += 1) {
      const u = Math.floor(rnd() * n);
      let v = Math.floor(rnd() * n);
      if (u === v) v = (v + 1) % n;
      const k = key(u, v);
      if (current.has(k) && rnd() < 0.5) {
        assert.equal(m.delEdge(u, v), 'OK');
        current.delete(k);
      } else {
        assert.equal(m.addEdge(u, v), 'OK'); // duplicate adds are no-ops
        current.add(k);
      }
      if (rnd() < 0.3) m.commit();
    }
    m.crashSim(points[Math.floor(rnd() * 3)]);
    // expected state = independent test-side replay of the surviving
    // complete records in the crashed log file
    const { records, partial } = parseLog(fs.readFileSync(log));
    const expected = new Set();
    for (const r of records) {
      if (r.op === 'add_edge') expected.add(key(r.u, r.v));
      else if (r.op === 'del_edge') expected.delete(key(r.u, r.v));
    }
    const expectedEdges = [...expected].map((k) => k.split(',').map(Number))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const r1 = new Monitor(log, { autoRecover: false }).recover();
    const r2 = new Monitor(log, { autoRecover: false }).recover();
    assert.equal(r1.discarded, partial ? 1 : 0);
    assert.equal(r1.state_hash, r2.state_hash);
    assert.equal(r2.discarded, 0); // second recover is clean
    assert.deepEqual(new Monitor(log).graph.edges(), expectedEdges);
  }
});
