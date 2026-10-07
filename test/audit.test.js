import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  proveReach,
  proveNonreach,
  verify,
  firstContamination,
  reachableSet,
  VERDICT,
  ProveTimeoutError,
  NoPathError,
  PathExistsError,
  NoSuchNodeError,
} from '../src/index.js';

const { VALID, CERT_INVALID, NO_SUCH_NODE, VERSION_MISMATCH } = VERDICT;

// Deterministic PRNG for reproducible property tests.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

// ---------- Acceptance 1: reach cert passes; tampering any edge fails ----------

test('reach: valid certificate verifies as VALID', () => {
  const g = buildGraph(['A', 'B', 'C', 'D'], [['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'D']]);
  const proof = proveReach(g, 'A', 'D');
  assert.deepEqual(proof.path, ['A', 'D']); // shortest path chosen
  assert.equal(verify(g, proof), VALID);
});

test('reach: modifying any edge in the certificate fails', () => {
  const g = buildGraph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  const proof = proveReach(g, 'A', 'C');
  assert.equal(verify(g, proof), VALID);
  for (let i = 0; i < proof.edges.length; i++) {
    for (const field of [0, 1]) {
      const tampered = clone(proof);
      tampered.edges[i][field] = tampered.edges[i][field] + '_x';
      assert.equal(verify(g, tampered), CERT_INVALID, `edge ${i} field ${field}`);
    }
  }
});

test('reach: modifying the underlying graph edge invalidates version binding', () => {
  const g1 = buildGraph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  const proof = proveReach(g1, 'A', 'C');
  const g2 = buildGraph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['A', 'C']]);
  assert.notEqual(g1.version, g2.version);
  assert.equal(verify(g2, proof), VERSION_MISMATCH);
});

test('reach: missing chain layer, fake path, and reordered edges are rejected', () => {
  const g = buildGraph(['A', 'B', 'C', 'D'], [['A', 'B'], ['B', 'C'], ['C', 'D']]);
  const proof = proveReach(g, 'A', 'D');

  const missingLayer = clone(proof);
  missingLayer.chain.pop();
  assert.equal(verify(g, missingLayer), CERT_INVALID);

  const fakePath = clone(proof);
  fakePath.path = ['A', 'D'];
  fakePath.edges = [['A', 'D']];
  assert.equal(verify(g, fakePath), CERT_INVALID);

  const fakeEdge = clone(proof);
  fakeEdge.edges[1] = ['B', 'D']; // edge does not exist in graph
  assert.equal(verify(g, fakeEdge), CERT_INVALID);

  const swapped = clone(proof);
  [swapped.chain[1], swapped.chain[2]] = [swapped.chain[2], swapped.chain[1]];
  assert.equal(verify(g, swapped), CERT_INVALID);
});

// ---------- Acceptance 2: nonreach cert passes; deleting boundary edge fails ----------

test('nonreach: valid certificate verifies as VALID', () => {
  const g = buildGraph(
    ['A', 'B', 'C', 'X', 'Y'],
    [['A', 'B'], ['B', 'C'], ['C', 'A'], ['X', 'Y']]
  );
  const proof = proveNonreach(g, 'A', 'Y');
  assert.deepEqual(proof.reachable, ['A', 'B', 'C']);
  assert.equal(verify(g, proof), VALID);
});

test('nonreach: deleting a boundary edge from the certificate fails', () => {
  const g = buildGraph(
    ['A', 'B', 'C', 'X'],
    [['A', 'B'], ['B', 'C'], ['A', 'C']]
  );
  const proof = proveNonreach(g, 'A', 'X');
  assert.ok(proof.boundary.length > 0);
  for (let i = 0; i < proof.boundary.length; i++) {
    const tampered = clone(proof);
    tampered.boundary.splice(i, 1);
    assert.equal(verify(g, tampered), CERT_INVALID, `removed boundary edge ${i}`);
  }
});

test('nonreach: deleting an edge from the graph gives VERSION_MISMATCH', () => {
  const g1 = buildGraph(['A', 'B', 'X'], [['A', 'B']]);
  const proof = proveNonreach(g1, 'A', 'X');
  const g2 = buildGraph(['A', 'B', 'X'], []);
  assert.equal(verify(g2, proof), VERSION_MISMATCH);
});

test('nonreach: shrinking or growing the reachable set is rejected', () => {
  const g = buildGraph(['A', 'B', 'C', 'X'], [['A', 'B'], ['B', 'C']]);
  const proof = proveNonreach(g, 'A', 'X');

  const shrunk = clone(proof);
  shrunk.reachable.pop();
  assert.equal(verify(g, shrunk), CERT_INVALID);

  const grown = clone(proof);
  grown.reachable.push('X');
  grown.reachable.sort();
  assert.equal(verify(g, grown), CERT_INVALID);
});

test('nonreach: proves fail when a path actually exists', () => {
  const g = buildGraph(['A', 'B'], [['A', 'B']]);
  assert.throws(() => proveNonreach(g, 'A', 'B'), PathExistsError);
  assert.throws(() => proveReach(g, 'B', 'A'), NoPathError);
});

// ---------- Acceptance 3: multi-source contamination, first contaminated edge ----------

test('contamination: locates the first contaminated edge among multiple sources', () => {
  // Raw material sources S1 (clean), S2 (contaminated). Product P.
  const g = buildGraph(
    ['S1', 'S2', 'M1', 'M2', 'P', 'Q'],
    [['S1', 'M1'], ['S2', 'M2'], ['M1', 'P'], ['M2', 'P'], ['P', 'Q']]
  );
  const hit = firstContamination(g, ['S1', 'S2'], 'Q');
  assert.equal(hit.source, 'S1'); // shortest path wins deterministically
  assert.deepEqual(hit.firstEdge, ['S1', 'M1']);

  const only = firstContamination(g, ['S2'], 'P');
  assert.equal(only.source, 'S2');
  assert.deepEqual(only.firstEdge, ['S2', 'M2']);
  assert.deepEqual(only.path, ['S2', 'M2', 'P']);

  assert.equal(firstContamination(g, ['Q'], 'S1'), null);
});

// ---------- Acceptance 4: n<=9 cross-check against BFS enumeration ----------

test('property: provers agree with BFS ground truth on random graphs n<=9', () => {
  const rng = mulberry32(20261008);
  for (let trial = 0; trial < 60; trial++) {
    const n = 1 + Math.floor(rng() * 9);
    const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
    const edges = [];
    for (const u of nodes) {
      for (const v of nodes) {
        if (rng() < 0.18) edges.push([u, v]); // may include self-loops
      }
    }
    const g = buildGraph(nodes, edges);
    for (const s of nodes) {
      const reach = reachableSet(g, s);
      for (const t of nodes) {
        if (reach.has(t)) {
          const proof = proveReach(g, s, t);
          assert.equal(verify(g, proof), VALID, `reach ${s}->${t} trial ${trial}`);
          assert.equal(proof.path[0], s);
          assert.equal(proof.path[proof.path.length - 1], t);
        } else {
          const proof = proveNonreach(g, s, t);
          assert.equal(verify(g, proof), VALID, `nonreach ${s}->${t} trial ${trial}`);
          assert.ok(!proof.reachable.includes(t));
        }
      }
    }
  }
});

// ---------- Acceptance 5: empty graph, self-loops, duplicate proof ids ----------

test('boundary: empty graph yields NO_SUCH_NODE on verify and errors on prove', () => {
  const g = buildGraph([], []);
  const fakeProof = {
    schema: 'proof-v1',
    type: 'reach',
    proofId: 'x',
    version: g.version,
    s: 'A',
    t: 'B',
    path: ['A', 'B'],
    edges: [['A', 'B']],
    chain: ['x', 'y'],
    bodyHash: 'x',
  };
  assert.equal(verify(g, fakeProof), NO_SUCH_NODE);
  assert.throws(() => proveReach(g, 'A', 'B'), NoSuchNodeError);
  assert.throws(() => proveNonreach(g, 'A', 'B'), NoSuchNodeError);
  assert.throws(() => buildGraph(['A'], [['A', 'B']]), NoSuchNodeError);
});

test('boundary: self-loops are handled (trivial and looped paths)', () => {
  const g = buildGraph(['A', 'B'], [['A', 'A'], ['A', 'B'], ['B', 'B']]);

  const trivial = proveReach(g, 'A', 'A'); // zero-length path
  assert.deepEqual(trivial.path, ['A']);
  assert.equal(trivial.edges.length, 0);
  assert.equal(trivial.chain.length, 1);
  assert.equal(verify(g, trivial), VALID);

  const looped = proveReach(g, 'A', 'B');
  assert.deepEqual(looped.path, ['A', 'B']);
  assert.equal(verify(g, looped), VALID);

  assert.throws(() => proveNonreach(g, 'A', 'A'), PathExistsError);
});

test('boundary: duplicate proof ids are deterministic; forged ids rejected', () => {
  const g = buildGraph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  const p1 = proveReach(g, 'A', 'C');
  const p2 = proveReach(g, 'A', 'C');
  assert.equal(p1.proofId, p2.proofId); // same inputs -> same id (idempotent)
  assert.equal(verify(g, p1), VALID);
  assert.equal(verify(g, p2), VALID);

  const forged = clone(p1);
  forged.proofId = '0'.repeat(64);
  assert.equal(verify(g, forged), CERT_INVALID);

  const n1 = proveNonreach(g, 'C', 'A');
  const n2 = proveNonreach(g, 'C', 'A');
  assert.equal(n1.proofId, n2.proofId);
  assert.notEqual(p1.proofId, n1.proofId);
});

test('boundary: malformed certificates are CERT_INVALID, never crash', () => {
  const g = buildGraph(['A', 'B'], [['A', 'B']]);
  for (const bad of [null, 42, 'proof', [], {}, { type: 'reach' }, { schema: 'proof-v1', type: 'wat', version: g.version, s: 'A', t: 'B' }]) {
    assert.equal(verify(g, bad), CERT_INVALID);
  }
});

// ---------- Timeout must never be reported as NO_PATH ----------

test('timeout: exhausted step budget raises PROVE_TIMEOUT, not NO_PATH', () => {
  const nodes = Array.from({ length: 50 }, (_, i) => `n${i}`);
  const edges = nodes.slice(0, -1).map((u, i) => [u, nodes[i + 1]]);
  nodes.push('isolated');
  const g = buildGraph(nodes, edges);
  assert.throws(() => proveReach(g, 'n0', 'n49', 5), ProveTimeoutError);
  assert.throws(() => proveNonreach(g, 'n0', 'isolated', 5), ProveTimeoutError);
  const err = () => { try { proveReach(g, 'n0', 'n49', 5); } catch (e) { return e; } };
  assert.equal(err().code, 'PROVE_TIMEOUT');
  assert.notEqual(err().code, 'NO_PATH');
});

// ---------- Scale: n=500, m=5000 ----------

test('scale: n=500, m=5000 proves and verifies quickly', () => {
  const rng = mulberry32(7);
  const n = 500, m = 5000;
  const nodes = Array.from({ length: n }, (_, i) => `v${i}`);
  const edges = new Set();
  while (edges.size < m) {
    edges.add(`v${Math.floor(rng() * n)}|v${Math.floor(rng() * n)}`);
  }
  const edgeList = [...edges].map((e) => e.split('|'));
  const g = buildGraph(nodes, edgeList);
  const reach = reachableSet(g, 'v0');
  const inside = nodes.find((x) => reach.has(x) && x !== 'v0');
  const outside = nodes.find((x) => !reach.has(x));
  if (inside) {
    const p = proveReach(g, 'v0', inside);
    assert.equal(verify(g, p), VALID);
  }
  if (outside) {
    const p = proveNonreach(g, 'v0', outside);
    assert.equal(verify(g, p), VALID);
  }
});
