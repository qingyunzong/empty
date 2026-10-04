'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/index.js');

const NOW = 1_700_000_000_000;

function freshStore() {
  return lib.build(
    ['M1', 'M2', 'MIX1', 'MIX2', 'P', 'Q'],
    [['M1', 'MIX1'], ['M2', 'MIX1'], ['MIX1', 'MIX2'], ['MIX2', 'P'], ['Q', 'M2']],
  );
}

function tampered(cert, mutate) {
  const copy = JSON.parse(JSON.stringify(cert));
  mutate(copy);
  return copy;
}

test('1. reach certificate verifies; tampering any edge fails', () => {
  const store = freshStore();
  const res = lib.prove_reach(store, 'M1', 'P', { now: NOW });
  assert.equal(res.ok, true);
  assert.deepEqual(res.cert.path, ['M1', 'MIX1', 'MIX2', 'P']);
  assert.equal(lib.verify(store, res.cert, { now: NOW }), 'VALID');

  for (let i = 0; i < res.cert.edge_hashes.length; i += 1) {
    const broken = tampered(res.cert, (c) => {
      c.edge_hashes[i] = '0'.repeat(64);
    });
    assert.equal(lib.verify(store, broken, { now: NOW }), 'CERT_INVALID', `edge hash ${i}`);
  }
  for (let i = 0; i < res.cert.path.length - 1; i += 1) {
    const broken = tampered(res.cert, (c) => {
      c.path[i + 1] = 'Q';
    });
    assert.equal(lib.verify(store, broken, { now: NOW }), 'CERT_INVALID', `path hop ${i}`);
  }
  const missingLayer = tampered(res.cert, (c) => {
    c.edge_hashes.pop();
  });
  assert.equal(lib.verify(store, missingLayer, { now: NOW }), 'CERT_INVALID', 'missing layer');
  const fakePath = tampered(res.cert, (c) => {
    c.path = ['M1', 'P'];
    c.edge_hashes = [c.edge_hashes[0]];
  });
  assert.equal(lib.verify(store, fakePath, { now: NOW }), 'CERT_INVALID', 'fake path');
});

test('2. nonreach certificate verifies; deleting a boundary edge fails', () => {
  const store = freshStore();
  const res = lib.prove_nonreach(store, 'M1', 'Q', { now: NOW });
  assert.equal(res.ok, true);
  assert.ok(res.cert.boundary.length > 0, 'boundary must be non-empty');
  assert.equal(lib.verify(store, res.cert, { now: NOW }), 'VALID');

  for (let i = 0; i < res.cert.boundary.length; i += 1) {
    const broken = tampered(res.cert, (c) => {
      c.boundary.splice(i, 1);
    });
    assert.equal(lib.verify(store, broken, { now: NOW }), 'CERT_INVALID', `boundary edge ${i}`);
  }
  const tInSet = tampered(res.cert, (c) => {
    c.reachable_set.push('Q');
  });
  assert.equal(lib.verify(store, tInSet, { now: NOW }), 'CERT_INVALID', 't inside set');
});

test('3. multi-source contamination locates first contaminating edge', () => {
  const store = freshStore();
  const res = lib.locate_contamination(store, ['M1', 'M2'], 'P');
  assert.equal(res.ok, true);
  assert.equal(res.source, 'M1');
  assert.deepEqual(res.first_edge, { from: 'M1', to: 'MIX1' });
  assert.deepEqual(res.path, ['M1', 'MIX1', 'MIX2', 'P']);

  const clean = lib.locate_contamination(store, ['Q'], 'P');
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.first_edge, { from: 'Q', to: 'M2' });

  const none = lib.locate_contamination(store, ['P'], 'M1');
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NO_CONTAMINATION');
});

function bruteForceReachable(nodes, edges, s, t) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) adj.get(a).push(b);
  const seen = new Set([s]);
  const stack = [s];
  while (stack.length) {
    const u = stack.pop();
    if (u === t) return true;
    for (const v of adj.get(u)) {
      if (!seen.has(v)) {
        seen.add(v);
        stack.push(v);
      }
    }
  }
  return false;
}

function enumerateSimplePaths(nodes, edges, s, t) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) adj.get(a).push(b);
  let found = false;
  const dfs = (u, visited) => {
    if (found) return;
    if (u === t) {
      found = true;
      return;
    }
    for (const v of adj.get(u)) {
      if (!visited.has(v)) {
        visited.add(v);
        dfs(v, visited);
        visited.delete(v);
      }
    }
  };
  dfs(s, new Set([s]));
  return found;
}

test('4. n<=9 random graphs cross-checked against BFS enumeration', () => {
  let rngState = 42;
  const rand = () => {
    rngState = (rngState * 1103515245 + 12345) % 2147483648;
    return rngState / 2147483648;
  };
  for (let trial = 0; trial < 60; trial += 1) {
    const n = 1 + Math.floor(rand() * 9);
    const nodes = Array.from({ length: n }, (_, i) => 'N' + i);
    const edges = [];
    for (const a of nodes) {
      for (const b of nodes) {
        if (rand() < 0.25) edges.push([a, b]);
      }
    }
    const store = lib.build(nodes, edges);
    for (const s of nodes) {
      for (const t of nodes) {
        const expected = bruteForceReachable(nodes, edges, s, t);
        assert.equal(
          enumerateSimplePaths(nodes, edges, s, t),
          expected,
          `enumeration mismatch ${s}->${t}`,
        );
        if (expected) {
          const r = lib.prove_reach(store, s, t, { now: NOW });
          assert.equal(r.ok, true, `prove_reach ${s}->${t}`);
          assert.equal(lib.verify(store, r.cert, { now: NOW }), 'VALID');
        } else {
          const r = lib.prove_nonreach(store, s, t, { now: NOW });
          assert.equal(r.ok, true, `prove_nonreach ${s}->${t}`);
          assert.equal(lib.verify(store, r.cert, { now: NOW }), 'VALID');
        }
      }
    }
  }
});

test('5. edge cases: empty graph, self-loop, duplicate proof id', () => {
  const empty = lib.build([], []);
  assert.equal(lib.prove_reach(empty, 'A', 'B').code, 'NO_SUCH_NODE');
  assert.equal(lib.prove_nonreach(empty, 'A', 'B').code, 'NO_SUCH_NODE');

  const loopStore = lib.build(['A', 'B'], [['A', 'A'], ['A', 'B']]);
  const selfReach = lib.prove_reach(loopStore, 'A', 'A', { now: NOW });
  assert.equal(selfReach.ok, true);
  assert.deepEqual(selfReach.cert.path, ['A']);
  assert.equal(lib.verify(loopStore, selfReach.cert, { now: NOW }), 'VALID');

  const loopNonreach = lib.prove_nonreach(loopStore, 'B', 'A', { now: NOW });
  assert.equal(loopNonreach.ok, true);
  assert.equal(lib.verify(loopStore, loopNonreach.cert, { now: NOW }), 'VALID');

  const store = freshStore();
  const first = lib.prove_reach(store, 'M1', 'P', { now: NOW });
  assert.equal(first.ok, true);
  const dup = lib.prove_reach(store, 'M1', 'P', { now: NOW });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'DUPLICATE_PROOF_ID');

  const forgedId = tampered(first.cert, (c) => {
    c.proof_id = 'f'.repeat(64);
  });
  assert.equal(lib.verify(store, forgedId, { now: NOW }), 'CERT_INVALID');
});

test('expiry, version binding and missing nodes on verify', () => {
  const store = freshStore();
  const res = lib.prove_reach(store, 'M1', 'P', { now: NOW, ttlMs: 1000 });
  assert.equal(lib.verify(store, res.cert, { now: NOW + 500 }), 'VALID');
  assert.equal(lib.verify(store, res.cert, { now: NOW + 2000 }), 'CERT_INVALID', 'expired');

  const extended = tampered(res.cert, (c) => {
    c.expires_at = NOW + 10_000_000;
  });
  assert.equal(lib.verify(store, extended, { now: NOW + 2000 }), 'CERT_INVALID', 'tampered expiry');

  const other = freshStore();
  const otherProof = lib.prove_nonreach(other, 'M1', 'Q', { now: NOW });
  const rebuilt = lib.build(['M1', 'M2', 'P'], [['M1', 'P']]);
  rebuilt.registry.push(otherProof.cert.proof_id);
  assert.equal(lib.verify(rebuilt, otherProof.cert, { now: NOW }), 'VERSION_MISMATCH');

});

test('verify reports NO_SUCH_NODE for endpoints absent from graph', () => {
  const store = freshStore();
  const res = lib.prove_reach(store, 'M1', 'P', { now: NOW });
  const renamed = tampered(res.cert, (c) => {
    c.t = 'UNKNOWN';
  });
  assert.equal(lib.verify(store, renamed, { now: NOW }), 'CERT_INVALID', 'integrity catches tamper');

  const { certHash } = require('../src/cert.js');
  const crafted = JSON.parse(JSON.stringify(res.cert));
  crafted.t = 'UNKNOWN';
  delete crafted.cert_hash;
  crafted.cert_hash = certHash(crafted);
  assert.equal(lib.verify(store, crafted, { now: NOW }), 'NO_SUCH_NODE');
});

test('scale: n=500, m=5000 prove and verify complete quickly', () => {
  const n = 500;
  const nodes = Array.from({ length: n }, (_, i) => 'V' + i);
  const edges = [];
  for (let i = 0; i + 1 < n; i += 1) edges.push(['V' + i, 'V' + (i + 1)]);
  let rngState = 7;
  const rand = () => {
    rngState = (rngState * 1103515245 + 12345) % 2147483648;
    return rngState / 2147483648;
  };
  while (edges.length < 5000) {
    const a = 'V' + Math.floor(rand() * n);
    const b = 'V' + Math.floor(rand() * n);
    edges.push([a, b]);
  }
  const store = lib.build(nodes, edges);
  const start = Date.now();
  const r = lib.prove_reach(store, 'V0', 'V499', { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(lib.verify(store, r.cert, { now: NOW }), 'VALID');
  const nr = lib.prove_nonreach(store, 'V499', 'V0', { now: NOW });
  if (nr.ok) assert.equal(lib.verify(store, nr.cert, { now: NOW }), 'VALID');
  assert.ok(Date.now() - start < 5000, 'must finish well within limits');
});
