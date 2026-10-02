import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStore, add, run, invalidate, audit, gc, tombstone, registerRunner,
  serialize, deserialize, ERR,
} from '../src/dag.js';
import { cliMain } from '../src/cli.js';

// Deterministic PRNG so failures reproduce.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDag(rand, n) {
  const specs = [];
  for (let i = 0; i < n; i += 1) {
    const deps = [];
    for (let j = 0; j < i; j += 1) {
      if (rand() < 0.25) deps.push(`n${j}`);
    }
    specs.push({
      id: `n${i}`,
      deps,
      inputHash: `in-${i}-${Math.floor(rand() * 1e6)}`,
      codeVersion: `v${Math.floor(rand() * 3)}`,
    });
  }
  return specs;
}

// Reference: affected set by independent reverse-edge BFS over the specs,
// then confirmed by enumerating the topological order and ancestor sets
// built from scratch (no library code involved).
function referenceAffected(specs, changedId) {
  const children = new Map(specs.map((s) => [s.id, []]));
  for (const s of specs) for (const d of s.deps) children.get(d).push(s.id);
  const affected = new Set([changedId]);
  const queue = [changedId];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of children.get(cur)) {
      if (!affected.has(next)) { affected.add(next); queue.push(next); }
    }
  }
  // Cross-check via topological enumeration + ancestor sets.
  const indeg = new Map(specs.map((s) => [s.id, s.deps.length]));
  const ready = specs.filter((s) => s.deps.length === 0).map((s) => s.id);
  const anc = new Map(specs.map((s) => [s.id, new Set()]));
  const topo = [];
  while (ready.length) {
    const cur = ready.pop();
    topo.push(cur);
    for (const next of children.get(cur)) {
      for (const a of anc.get(cur)) anc.get(next).add(a);
      anc.get(next).add(cur);
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) ready.push(next);
    }
  }
  assert.equal(topo.length, specs.length, 'reference topo order covers all nodes');
  const viaAnc = new Set([changedId]);
  for (const s of specs) if (anc.get(s.id).has(changedId)) viaAnc.add(s.id);
  assert.deepEqual([...affected].sort(), [...viaAnc].sort(),
    'BFS and topological-enumeration references agree');
  return affected;
}

function buildStore(specs) {
  const store = createStore();
  for (const s of specs) add(store, s);
  return store;
}

test('random DAGs (<=20 nodes): invalidation set matches topological reference', () => {
  for (let seed = 1; seed <= 50; seed += 1) {
    const rand = mulberry32(seed);
    const n = 2 + Math.floor(rand() * 19); // 2..20 nodes
    const specs = randomDag(rand, n);
    const store = buildStore(specs);
    run(store);
    assert.equal(Object.keys(store.cache).length, n, `seed ${seed}: all cached`);

    const target = `n${Math.floor(rand() * n)}`;
    const before = structuredClone(store.cache);
    const { invalidated } = invalidate(store, { id: target, inputHash: `correction-${seed}` });
    const expected = referenceAffected(specs, target);

    assert.deepEqual(invalidated, [...expected].sort(), `seed ${seed}: invalidated set`);
    for (const s of specs) {
      const had = before[s.id];
      if (expected.has(s.id)) {
        assert.equal(store.cache[s.id], undefined, `seed ${seed}: ${s.id} evicted`);
      } else {
        assert.deepEqual(store.cache[s.id], had, `seed ${seed}: ${s.id} cache untouched`);
      }
    }
    // Re-run recomputes exactly the invalidated set.
    const again = run(store);
    assert.deepEqual(again.computed.slice().sort(), [...expected].sort(),
      `seed ${seed}: rerun recomputes exactly the affected set`);
  }
});

test('correcting a leaf never touches its siblings', () => {
  const store = buildStore([
    { id: 'raw', deps: [], inputHash: 'h0', codeVersion: 'v1' },
    { id: 'parent', deps: ['raw'], inputHash: 'h1', codeVersion: 'v1' },
    { id: 'leaf-x', deps: ['parent'], inputHash: 'hx', codeVersion: 'v1' },
    { id: 'leaf-y', deps: ['parent'], inputHash: 'hy', codeVersion: 'v1' },
    { id: 'report', deps: ['leaf-y'], inputHash: 'hr', codeVersion: 'v1' },
  ]);
  run(store);
  const keep = Object.fromEntries(
    ['raw', 'parent', 'leaf-y', 'report'].map((id) => [id, store.cache[id]]),
  );
  const { invalidated } = invalidate(store, { id: 'leaf-x', inputHash: 'hx-fixed' });
  assert.deepEqual(invalidated, ['leaf-x']);
  for (const [id, entry] of Object.entries(keep)) {
    assert.deepEqual(store.cache[id], entry, `${id} untouched`);
  }
});

test('fixed errors: CYCLE, MISSING_INPUT, BAD_CERT', () => {
  const store = buildStore([
    { id: 'a', deps: [], inputHash: 'h', codeVersion: 'v1' },
    { id: 'b', deps: ['a'], inputHash: 'h', codeVersion: 'v1' },
  ]);
  assert.throws(() => add(store, { id: 'a', deps: ['b'], inputHash: 'h', codeVersion: 'v2' }),
    (e) => e.code === ERR.CYCLE);
  assert.throws(() => add(store, { id: 'c', deps: ['c'], inputHash: 'h', codeVersion: 'v1' }),
    (e) => e.code === ERR.CYCLE);
  assert.throws(() => add(store, { id: 'd', deps: ['ghost'], inputHash: 'h', codeVersion: 'v1' }),
    (e) => e.code === ERR.MISSING_INPUT);
  assert.throws(
    () => add(store, { id: 'e', deps: ['a'], inputHash: 'h', codeVersion: 'v1',
      cert: { prev: 'forged', hash: 'deadbeef' } }),
    (e) => e.code === ERR.BAD_CERT);
  // Failed adds must not corrupt the store.
  assert.equal(audit(store).ok, true);
});

test('audit verifies hash chain from roots to leaves; tampering is caught', () => {
  const store = buildStore([
    { id: 'root', deps: [], inputHash: 'h0', codeVersion: 'v1' },
    { id: 'mid', deps: ['root'], inputHash: 'h1', codeVersion: 'v1' },
    { id: 'leaf', deps: ['mid'], inputHash: 'h2', codeVersion: 'v1' },
  ]);
  const ok = audit(store);
  assert.equal(ok.ok, true);
  assert.equal(ok.nodes, 3);
  store.nodes.mid.cert.hash = 'tampered';
  const bad = audit(store);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, ERR.BAD_CERT);
});

test('gc keeps audit identical and only collects runner-confirmed tombstones', () => {
  const store = buildStore([
    { id: 'raw', deps: [], inputHash: 'h0', codeVersion: 'v1' },
    { id: 'clean', deps: ['raw'], inputHash: 'h1', codeVersion: 'v1' },
    { id: 'plot', deps: ['clean'], inputHash: 'h2', codeVersion: 'v1' },
    { id: 'scratch', deps: ['raw'], inputHash: 'h3', codeVersion: 'v1' },
  ]);
  run(store);
  registerRunner(store, 'runner-1');
  registerRunner(store, 'runner-2');

  tombstone(store, 'scratch');
  tombstone(store, 'clean'); // still referenced by live node 'plot'
  const before = audit(store);
  assert.equal(before.ok, true);

  // Only one runner confirms: nothing collected.
  let out = gc(store, { 'runner-1': ['scratch', 'clean'] });
  assert.deepEqual(out.collected, []);
  assert.deepEqual(out.retained, ['clean', 'scratch']);

  // All runners confirm: 'scratch' collected; 'clean' retained because the
  // live node 'plot' still depends on it.
  out = gc(store, { 'runner-1': ['scratch', 'clean'], 'runner-2': ['clean', 'scratch'] });
  assert.deepEqual(out.collected, ['scratch']);
  assert.deepEqual(out.retained, ['clean']);
  const after = audit(store);
  assert.equal(after.ok, before.ok);
  assert.deepEqual(after.errors, before.errors);
  // 'scratch' was already unreachable from the live graph, so the audited
  // chain (raw -> clean -> plot, with clean a retained tombstone) is unchanged.
  assert.equal(after.nodes, before.nodes);
  assert.equal(audit(store).ok, true, 'chain through retained tombstone still verifies');
});

test('store survives a serialize/deserialize round trip', () => {
  const store = buildStore([
    { id: 'a', deps: [], inputHash: 'h', codeVersion: 'v1' },
    { id: 'b', deps: ['a'], inputHash: 'h', codeVersion: 'v1' },
  ]);
  run(store);
  const clone = deserialize(serialize(store));
  assert.deepEqual(audit(clone), audit(store));
  assert.deepEqual(run(clone).cached.sort(), ['a', 'b']);
});

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process through cliMain with injected I/O (same code path as the bin
// wrapper, which is a thin adapter over process streams).
test('CLI end-to-end: add/run/invalidate/audit/gc with JSON I/O', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repro-dag-'));
  const state = join(dir, 'state.json');
  const invoke = (args, input) => {
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify(input ?? {}));
    let stdout = '';
    let stderr = '';
    const code = cliMain([...args, '--state', state, '--file', file], {
      readStdin: () => '{}',
      writeOut: (s) => { stdout += s; },
      writeErr: (s) => { stderr += s; },
    });
    return { code, stdout, stderr };
  };
  const cli = (args, input) => {
    const res = invoke(args, input);
    assert.equal(res.code, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  const cliErr = (args, input) => {
    const res = invoke(args, input);
    assert.equal(res.code, 1);
    return JSON.parse(res.stderr);
  };

  cli(['add'], { id: 'raw', deps: [], inputHash: 'h0', codeVersion: 'v1' });
  cli(['add'], { id: 'clean', deps: ['raw'], inputHash: 'h1', codeVersion: 'v1' });
  const first = cli(['run']);
  assert.deepEqual(first.computed.sort(), ['clean', 'raw']);
  const second = cli(['run']);
  assert.equal(second.computed.length, 0, 'warm cache: nothing recomputed');

  const inv = cli(['invalidate'], { id: 'raw', inputHash: 'h0-fixed' });
  assert.deepEqual(inv.invalidated, ['clean', 'raw']);

  assert.equal(cli(['audit']).ok, true);

  const cyc = cliErr(['add'], { id: 'raw', deps: ['clean'], inputHash: 'h', codeVersion: 'v9' });
  assert.equal(cyc.error.code, 'CYCLE');
  const miss = cliErr(['add'], { id: 'x', deps: ['nope'], inputHash: 'h', codeVersion: 'v1' });
  assert.equal(miss.error.code, 'MISSING_INPUT');
  const bad = cliErr(['add'], { id: 'y', deps: [], inputHash: 'h', codeVersion: 'v1',
    cert: { prev: 'p', hash: 'q' } });
  assert.equal(bad.error.code, 'BAD_CERT');

  cli(['register-runner'], { id: 'r1' });
  cli(['tombstone'], { id: 'clean' });
  const before = cli(['audit']);
  const gcOut = cli(['gc'], { confirmations: { r1: ['clean'] } });
  assert.deepEqual(gcOut.collected, ['clean']);
  const after = cli(['audit']);
  assert.equal(after.ok, before.ok);
  assert.ok(readFileSync(state, 'utf8').length > 0);
});
