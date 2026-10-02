import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCycles, cycleKey } from '../src/cycles.js';
import { buildWaitEdges, computeCertificates } from '../src/engine.js';

// Independent brute-force reference: enumerate every directed elementary
// cycle by trying all node subsets and all of their permutations.
function referenceCycles(nodes, adj) {
  const found = new Set();
  const permute = (arr, k, cb) => {
    if (k === arr.length) {
      cb([...arr]);
      return;
    }
    for (let i = k; i < arr.length; i += 1) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      permute(arr, k + 1, cb);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  const combine = (start, picked, size) => {
    if (picked.length === size) {
      permute([...picked], 0, (perm) => {
        const minNode = [...perm].sort()[0];
        if (perm[0] !== minNode) return; // canonical rotation only
        for (let i = 0; i < perm.length; i += 1) {
          const next = perm[(i + 1) % perm.length];
          if (!(adj.get(perm[i]) ?? new Set()).has(next)) return;
        }
        found.add(cycleKey(perm));
      });
      return;
    }
    for (let i = start; i < nodes.length; i += 1) {
      picked.push(nodes[i]);
      combine(i + 1, picked, size);
      picked.pop();
    }
  };
  for (let size = 2; size <= nodes.length; size += 1) combine(0, [], size);
  return found;
}

function adjFromWaits(waits) {
  const adj = new Map();
  for (const w of waits) {
    if (!adj.has(w.from)) adj.set(w.from, new Set());
    adj.get(w.from).add(w.to);
    if (!adj.has(w.to)) adj.set(w.to, new Set());
  }
  return adj;
}

// Acceptance 3: exhaustively enumerate every overlap pattern for <= 4 AGVs
// and cross-check the detected cycles against the brute-force reference.
// Ring topology: agv i holds edge E(i) and requests edge E(i+1 mod n), so
// waits can genuinely close into cycles depending on the interval overlaps.
test('acceptance 3: exhaustive <=4-agv overlap patterns match reference cycles', () => {
  const TIMES = [0, 1, 2];
  const WINDOW = 2;
  const AGVS = ['A', 'B', 'C', 'D'];
  let checked = 0;
  let cyclesSeen = 0;

  for (let n = 2; n <= 4; n += 1) {
    const agvs = AGVS.slice(0, n);
    const total = TIMES.length ** (2 * n);
    for (let combo = 0; combo < total; combo += 1) {
      let x = combo;
      const pick = () => {
        const t = TIMES[x % TIMES.length];
        x = Math.floor(x / TIMES.length);
        return t;
      };
      const reserves = [];
      const pings = [];
      for (let i = 0; i < n; i += 1) {
        const holdTs = pick();
        const wantTs = pick();
        const holdEdge = `E${i}`;
        const wantEdge = `E${(i + 1) % n}`;
        reserves.push({ id: `H${i}`, agv: agvs[i], edge: holdEdge, eventTs: holdTs });
        reserves.push({ id: `W${i}`, agv: agvs[i], edge: wantEdge, eventTs: wantTs });
        // Confirm both reserves with pings inside their windows.
        pings.push({ id: `PH${i}`, agv: agvs[i], eventTs: holdTs });
        pings.push({ id: `PW${i}`, agv: agvs[i], eventTs: wantTs });
      }

      const waits = buildWaitEdges(reserves, pings, WINDOW);
      const adj = adjFromWaits(waits);
      const actual = new Set(findCycles(adj).map(cycleKey));
      const expected = referenceCycles([...adj.keys()], adj);
      assert.deepEqual(actual, expected, `mismatch for combo=${combo} n=${n}`);

      // Certificates must be deterministic across recomputation.
      const certs1 = computeCertificates(waits);
      const certs2 = computeCertificates(waits);
      assert.deepEqual(certs1, certs2);
      assert.equal(certs1.length, actual.size);

      checked += 1;
      cyclesSeen += actual.size;
    }
  }
  assert.equal(checked, 81 + 729 + 6561);
  assert.ok(cyclesSeen > 0, 'exhaustive sweep should produce some cycles');
});

test('findCycles finds disjoint and nested cycles', () => {
  const adj = new Map([
    ['A', new Set(['B'])],
    ['B', new Set(['A', 'C'])],
    ['C', new Set(['A'])],
    ['D', new Set(['E'])],
    ['E', new Set(['D'])],
  ]);
  const keys = findCycles(adj).map(cycleKey).sort();
  assert.deepEqual(keys, ['A→B', 'A→B→C', 'D→E']);
});

test('acyclic graphs yield no cycles', () => {
  const adj = new Map([
    ['A', new Set(['B', 'C'])],
    ['B', new Set(['D'])],
    ['C', new Set(['D'])],
    ['D', new Set()],
  ]);
  assert.deepEqual(findCycles(adj), []);
});
