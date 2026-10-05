import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RecallGraph,
  DomainError,
  applyEvent,
  verifyCertificate,
  EXIT_DOMAIN_ERROR,
} from '../lib.js';
import { runTrace } from '../cli.js';

// Acceptance 1: a multi-parent batch leaves the cone only after ALL supports vanish.
test('multi-parent batch removed only after all supports gone', () => {
  const g = new RecallGraph();
  g.addEdge('S', 'M', 1);
  g.addEdge('S', 'N', 1);
  g.addEdge('M', 'X', 1);
  g.addEdge('N', 'X', 1);
  g.markBad('S');
  assert.ok(g.affected.has('X'));

  g.delEdge('M', 'X'); // one support left via N
  assert.ok(g.affected.has('X'), 'X still supported via N');

  g.delEdge('N', 'X'); // last support gone
  assert.ok(!g.affected.has('X'), 'X leaves cone only after final support removed');
  assert.deepEqual(g.affectedList(), ['M', 'N', 'S']);
});

// Acceptance 2: inserting a shortcut expands the cone and coneSize is exact.
test('shortcut insertion expands cone with exact coneSize', () => {
  const g = new RecallGraph();
  g.addEdge('S', 'A', 1);
  g.addEdge('A', 'B', 1);
  g.addEdge('X', 'Y', 1);
  g.addEdge('Y', 'Z', 1);
  g.markBad('S');
  assert.equal(g.query('B').coneSize, 3); // S, A, B

  g.addEdge('B', 'X', 2); // shortcut into the detached chain
  const result = g.query('Z');
  assert.deepEqual(result.affected, ['A', 'B', 'S', 'X', 'Y', 'Z']);
  assert.equal(result.coneSize, 6);

  g.delEdge('B', 'X'); // cone shrinks back exactly
  assert.equal(g.query('B').coneSize, 3);
  assert.deepEqual(g.affectedList(), ['A', 'B', 'S']);
});

// Acceptance 3: random DAGs (n <= 8) cross-checked against explicit reverse BFS.
test('random DAG ops match explicit reverse BFS', () => {
  let seed = 0xC0FFEE;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };

  for (let trial = 0; trial < 150; trial += 1) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 nodes
    const names = Array.from({ length: n }, (_, i) => `n${i}`);
    const perm = [...names].sort(() => rand() - 0.5); // fixed topo order
    const rank = new Map(perm.map((name, i) => [name, i]));

    const g = new RecallGraph();
    const mirror = new Map(names.map((name) => [name, new Set()]));
    const bad = new Set();
    let ver = 0;

    const bruteForce = () => {
      // Explicit reverse BFS: node affected iff a bad node reaches it forward.
      const seen = new Set(bad);
      const queue = [...bad];
      while (queue.length > 0) {
        const cur = queue.shift();
        for (const next of mirror.get(cur)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return [...seen].sort();
    };

    for (let step = 0; step < 60; step += 1) {
      const op = rand();
      if (op < 0.45) {
        const a = perm[Math.floor(rand() * n)];
        const b = perm[Math.floor(rand() * n)];
        if (rank.get(a) < rank.get(b) && !mirror.get(a).has(b)) {
          ver += 1;
          g.addEdge(a, b, ver);
          mirror.get(a).add(b);
        }
      } else if (op < 0.7) {
        const edges = [];
        for (const [from, tos] of mirror) for (const to of tos) edges.push([from, to]);
        if (edges.length > 0) {
          const [from, to] = edges[Math.floor(rand() * edges.length)];
          g.delEdge(from, to);
          mirror.get(from).delete(to);
        }
      } else {
        const node = names[Math.floor(rand() * n)];
        if (!bad.has(node)) {
          g.markBad(node);
          bad.add(node);
        }
      }
      assert.deepEqual(
        g.affectedList(),
        bruteForce(),
        `trial ${trial} step ${step}: cone diverged from reverse BFS`,
      );
      assert.equal(g.coneSize, bruteForce().length);
    }
  }
});

// Acceptance 4: certificate replays offline against the current library.
test('certificate replay matches current library; tampering rejected', () => {
  const events = [
    { edge: { from: 'S', to: 'A', ver: 1 } },
    { edge: { from: 'A', to: 'B', ver: 1 } },
    { edge: { from: 'S', to: 'B', ver: 2 } },
    { markBad: { node: 'S' } },
    { query: { node: 'B' } },
  ];
  const g = new RecallGraph();
  let result = null;
  for (const event of events) {
    const r = applyEvent(g, event);
    if (r) result = r;
  }
  assert.ok(result.cert, 'affected query must carry a certificate');
  assert.equal(verifyCertificate(events, result.cert), true);

  const cert = result.cert;
  assert.equal(verifyCertificate(events, { ...cert, queryHash: '0'.repeat(64) }), false);
  assert.equal(
    verifyCertificate(events, { ...cert, edges: [{ ...cert.edges[0], ver: 99 }, ...cert.edges.slice(1)] }),
    false,
  );
  assert.equal(
    verifyCertificate(events, { ...cert, path: [...cert.path, 'ghost'] }),
    false,
  );
  // Replay against a diverging history must fail.
  const other = events.map((e, i) => (i === 0 ? { edge: { from: 'S', to: 'A', ver: 7 } } : e));
  assert.equal(verifyCertificate(other, cert), false);
});

// Acceptance 5: delEdge on a missing edge errors and leaves the state hash untouched.
test('delEdge on missing edge errors without mutating state', () => {
  const g = new RecallGraph();
  g.addEdge('S', 'A', 1);
  g.markBad('S');
  const hash = g.stateHash();
  assert.throws(
    () => g.delEdge('A', 'S'),
    (err) => err instanceof DomainError && err.code === 'EDGE_NOT_FOUND',
  );
  assert.throws(
    () => g.delEdge('S', 'ghost'),
    (err) => err instanceof DomainError && err.code === 'EDGE_NOT_FOUND',
  );
  assert.equal(g.stateHash(), hash, 'state hash must be unchanged after failed delEdge');
});

// Domain errors carry exit code 11 and the CLI honours it.
test('cycle, version regression, unknown query node -> exit code 11', () => {
  const g = new RecallGraph();
  g.addEdge('A', 'B', 1);
  g.addEdge('B', 'C', 1);
  assert.throws(() => g.addEdge('C', 'A', 2), (e) => e.code === 'CYCLE' && e.exitCode === 11);
  assert.throws(() => g.addEdge('A', 'A', 2), (e) => e.code === 'CYCLE');
  assert.throws(() => g.addEdge('A', 'B', 0), (e) => e.code === 'VERSION_REGRESSION' && e.exitCode === 11);
  g.delEdge('A', 'B');
  assert.throws(() => g.addEdge('A', 'B', 0), (e) => e.code === 'VERSION_REGRESSION',
    'version floor survives deletion');
  assert.throws(() => g.query('nobody'), (e) => e.code === 'UNKNOWN_NODE' && e.exitCode === 11);

  for (const [name, lines] of [
    ['cycle', [{ edge: { from: 'A', to: 'B', ver: 1 } }, { edge: { from: 'B', to: 'A', ver: 1 } }]],
    ['regression', [{ edge: { from: 'A', to: 'B', ver: 2 } }, { edge: { from: 'A', to: 'B', ver: 1 } }]],
    ['unknown-query', [{ edge: { from: 'A', to: 'B', ver: 1 } }, { query: { node: 'ZZ' } }]],
    ['missing-delEdge', [{ delEdge: { from: 'A', to: 'B' } }]],
  ]) {
    const run = runTrace(lines);
    assert.equal(run.code, EXIT_DOMAIN_ERROR, `${name}: expected exit 11, got ${run.code}`);
    assert.match(run.err.join('\n'), /"error":/);
  }
});

// CLI driver end-to-end: query output shape and --verify replay.
test('runTrace emits affected/cert/coneSize and verifies offline', () => {
  const lines = [
    { edge: { from: 'S', to: 'A', ver: 1 } },
    { edge: { from: 'A', to: 'B', ver: 1 } },
    { markBad: { node: 'S' } },
    { query: { node: 'B' } },
    { query: { node: 'A' } },
  ];
  const run = runTrace(lines);
  assert.equal(run.code, 0);
  const out = run.out.map((l) => JSON.parse(l));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].affected, ['A', 'B', 'S']);
  assert.equal(out[0].coneSize, 3);
  assert.equal(out[0].cert.path.join('>'), 'S>A>B');
  assert.equal(out[1].cert.path.join('>'), 'S>A');

  const verify = runTrace(lines, { verify: true });
  assert.equal(verify.code, 0);
  const checks = verify.out.map((l) => JSON.parse(l)).filter((r) => r.type === 'verify');
  assert.deepEqual(checks.map((c) => c.ok), [true, true]);
});
