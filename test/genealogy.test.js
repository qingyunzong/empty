'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  normalizeVersion,
  mergeVersions,
  mergedToJson,
  hashVersion,
  isDag,
  reachableFrom,
  InputError,
} = require('../index.js');

const INDEX = path.join(__dirname, '..', 'index.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genealogy-test-'));
}

function writeJson(dir, name, value) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  return p;
}

function runCli({ base, local, remote, dir }) {
  const basePath = writeJson(dir, 'base.json', base);
  const localPath = writeJson(dir, 'local.json', local);
  const remotePath = writeJson(dir, 'remote.json', remote);
  const outPath = path.join(dir, 'out.json');
  const errPath = path.join(dir, 'stderr.txt');
  const cmd = [
    JSON.stringify(process.execPath),
    JSON.stringify(INDEX),
    'merge-genealogy',
    '--base', JSON.stringify(basePath),
    '--local', JSON.stringify(localPath),
    '--remote', JSON.stringify(remotePath),
    '--out', JSON.stringify(outPath),
    '2>' + JSON.stringify(errPath),
  ].join(' ');
  const proc = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
  const out = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;
  const stderr = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '';
  return { status: proc.status, stdout: proc.stdout, stderr, out };
}

function edgeSetOf(jsonEdges) {
  return new Set(jsonEdges.map((e) => `${e.child}->${e.parent}:${e.relation}`));
}

test('acceptance 1: disjoint edges added on both sides merge cleanly', () => {
  const dir = makeTmpDir();
  const base = { nodes: ['A', 'B', 'C', 'D'], edges: [] };
  const local = { nodes: ['A', 'B', 'C', 'D'], edges: [{ child: 'A', parent: 'B', relation: 'consumed' }] };
  const remote = { nodes: ['A', 'B', 'C', 'D'], edges: [{ child: 'C', parent: 'D', relation: 'derived' }] };
  const r = runCli({ base, local, remote, dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.status, 'merged');
  assert.deepEqual(r.out.conflicts, []);
  assert.deepEqual(
    edgeSetOf(r.out.merged.edges),
    new Set(['A->B:consumed', 'C->D:derived'])
  );
  assert.deepEqual(r.out.merged.nodes, ['A', 'B', 'C', 'D']);
  assert.match(r.out.baseHash, /^[0-9a-f]{64}$/);
});

test('acceptance 2: delete on one side vs relation change on the other conflicts', () => {
  const dir = makeTmpDir();
  const base = { nodes: ['A', 'B'], edges: [{ child: 'A', parent: 'B', relation: 'consumed' }] };
  const local = { nodes: ['A', 'B'], edges: [] };
  const remote = { nodes: ['A', 'B'], edges: [{ child: 'A', parent: 'B', relation: 'blended' }] };
  const r = runCli({ base, local, remote, dir });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.status, 'conflict');
  assert.equal(r.out.conflicts.length, 1);
  const c = r.out.conflicts[0];
  assert.equal(c.type, 'edge-conflict');
  assert.equal(c.child, 'A');
  assert.equal(c.parent, 'B');
  assert.equal(c.base, 'consumed');
  assert.equal(c.local, null);
  assert.equal(c.remote, 'blended');
});

test('acceptance 3: individually valid sides that form a cycle together conflict', () => {
  const dir = makeTmpDir();
  const base = { nodes: ['A', 'B'], edges: [] };
  const local = { nodes: ['A', 'B'], edges: [{ child: 'A', parent: 'B', relation: 'r1' }] };
  const remote = { nodes: ['A', 'B'], edges: [{ child: 'B', parent: 'A', relation: 'r2' }] };
  const r = runCli({ base, local, remote, dir });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.status, 'conflict');
  const cycleConflicts = r.out.conflicts.filter((c) => c.type === 'cycle');
  assert.equal(cycleConflicts.length, 1);
  assert.ok(cycleConflicts[0].path.includes('A'));
  assert.ok(cycleConflicts[0].path.includes('B'));
});

test('exit 2: malformed JSON input', () => {
  const dir = makeTmpDir();
  const r = runCli({
    base: '{ not json',
    local: { nodes: ['A'], edges: [] },
    remote: { nodes: ['A'], edges: [] },
    dir,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid JSON/);
});

test('exit 2: edge referencing an unknown node', () => {
  const dir = makeTmpDir();
  const r = runCli({
    base: { nodes: ['A'], edges: [{ child: 'A', parent: 'ZZZ', relation: 'x' }] },
    local: { nodes: ['A'], edges: [] },
    remote: { nodes: ['A'], edges: [] },
    dir,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown node/);
});

test('exit 2: self-loop edge in input', () => {
  const dir = makeTmpDir();
  const r = runCli({
    base: { nodes: ['A'], edges: [{ child: 'A', parent: 'A', relation: 'x' }] },
    local: { nodes: ['A'], edges: [] },
    remote: { nodes: ['A'], edges: [] },
    dir,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /self-loop/);
});

test('exit 2: cycle in an input version', () => {
  const dir = makeTmpDir();
  const r = runCli({
    base: { nodes: ['A', 'B'], edges: [] },
    local: {
      nodes: ['A', 'B'],
      edges: [
        { child: 'A', parent: 'B', relation: 'x' },
        { child: 'B', parent: 'A', relation: 'y' },
      ],
    },
    remote: { nodes: ['A', 'B'], edges: [] },
    dir,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cycle/);
});

test('exit 2: missing required CLI options or unknown command', () => {
  const proc1 = spawnSync(process.execPath, [INDEX], { encoding: 'utf8' });
  assert.equal(proc1.status, 2);
  const proc2 = spawnSync(process.execPath, [INDEX, 'merge-genealogy', '--base', 'x.json'], { encoding: 'utf8' });
  assert.equal(proc2.status, 2);
  const proc3 = spawnSync(process.execPath, [INDEX, 'bogus'], { encoding: 'utf8' });
  assert.equal(proc3.status, 2);
});

test('merge: change on only one side is adopted (add, delete, modify)', () => {
  const base = normalizeVersion({
    nodes: ['A', 'B', 'C'],
    edges: [
      { child: 'A', parent: 'B', relation: 'old' },
      { child: 'C', parent: 'A', relation: 'gone' },
    ],
  }, 'base');
  const local = normalizeVersion({
    nodes: ['A', 'B', 'C'],
    edges: [
      { child: 'A', parent: 'B', relation: 'new' },
      { child: 'B', parent: 'C', relation: 'added' },
    ],
  }, 'local');
  const remote = normalizeVersion({
    nodes: ['A', 'B', 'C'],
    edges: [
      { child: 'A', parent: 'B', relation: 'old' },
      { child: 'C', parent: 'A', relation: 'gone' },
    ],
  }, 'remote');
  const { merged, conflicts } = mergeVersions(base, local, remote);
  assert.deepEqual(conflicts, []);
  const json = mergedToJson(merged);
  assert.deepEqual(edgeSetOf(json.edges), new Set(['A->B:new', 'B->C:added']));
});

test('merge: identical changes on both sides are adopted once', () => {
  const base = normalizeVersion({
    nodes: ['A', 'B'],
    edges: [{ child: 'A', parent: 'B', relation: 'old' }],
  }, 'base');
  const side = normalizeVersion({
    nodes: ['A', 'B', 'C'],
    edges: [{ child: 'B', parent: 'C', relation: 'fresh' }],
  }, 'side');
  const { merged, conflicts } = mergeVersions(base, side, side);
  assert.deepEqual(conflicts, []);
  const json = mergedToJson(merged);
  assert.deepEqual(edgeSetOf(json.edges), new Set(['B->C:fresh']));
  assert.deepEqual(json.nodes, ['A', 'B', 'C']);
});

test('merge: both sides set different relations on the same new edge conflict', () => {
  const base = normalizeVersion({ nodes: ['A', 'B'], edges: [] }, 'base');
  const local = normalizeVersion({
    nodes: ['A', 'B'],
    edges: [{ child: 'A', parent: 'B', relation: 'x' }],
  }, 'local');
  const remote = normalizeVersion({
    nodes: ['A', 'B'],
    edges: [{ child: 'A', parent: 'B', relation: 'y' }],
  }, 'remote');
  const { conflicts } = mergeVersions(base, local, remote);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'edge-conflict');
});

test('merge: node removed on one side but referenced by a new edge on the other conflicts', () => {
  const base = normalizeVersion({ nodes: ['A', 'B'], edges: [] }, 'base');
  const local = normalizeVersion({ nodes: ['A'], edges: [] }, 'local');
  const remote = normalizeVersion({
    nodes: ['A', 'B'],
    edges: [{ child: 'A', parent: 'B', relation: 'x' }],
  }, 'remote');
  const { conflicts } = mergeVersions(base, local, remote);
  assert.ok(conflicts.some((c) => c.type === 'dangling-reference'));
});

test('hash: canonical hash is stable across key and edge ordering', () => {
  const v1 = normalizeVersion({
    nodes: ['C', 'B', 'A'],
    edges: [
      { child: 'B', parent: 'C', relation: 's' },
      { child: 'A', parent: 'B', relation: 'r' },
    ],
  }, 'v1');
  const v2 = normalizeVersion({
    edges: [{ child: 'A', parent: 'B', relation: 'r' }, { child: 'B', parent: 'C', relation: 's' }],
    nodes: ['A', 'B', 'C'],
  }, 'v2');
  assert.equal(hashVersion(v1), hashVersion(v2));
});

test('normalizeVersion: lots contribute their batches as nodes', () => {
  const v = normalizeVersion({
    lots: [{ id: 'L1', batches: ['A', 'B'] }],
    edges: [{ child: 'A', parent: 'B', relation: 'consumed' }],
  }, 'v');
  assert.deepEqual([...v.nodes].sort(), ['A', 'B']);
  assert.equal(v.edges.size, 1);
});

test('normalizeVersion: rejects malformed structures with InputError', () => {
  assert.throws(() => normalizeVersion(null, 'x'), InputError);
  assert.throws(() => normalizeVersion([], 'x'), InputError);
  assert.throws(() => normalizeVersion({ nodes: 'nope' }, 'x'), InputError);
  assert.throws(() => normalizeVersion({ nodes: [42] }, 'x'), InputError);
  assert.throws(
    () => normalizeVersion({ nodes: ['A'], edges: [{ child: 'A', parent: 'A', relation: 'r' }] }, 'x'),
    /self-loop/
  );
  assert.throws(
    () => normalizeVersion({ nodes: ['A', 'B'], edges: [
      { child: 'A', parent: 'B', relation: 'r1' },
      { child: 'A', parent: 'B', relation: 'r2' },
    ] }, 'x'),
    /duplicate edge/
  );
});

function independentHasCycle(nodes, pairs) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [c, p] of pairs) adj.get(c).push(p);
  function reaches(start, target, visited) {
    if (start === target) return true;
    if (visited.has(start)) return false;
    visited.add(start);
    for (const next of adj.get(start)) {
      if (reaches(next, target, visited)) return true;
    }
    return false;
  }
  for (const n of nodes) {
    for (const next of adj.get(n)) {
      if (reaches(next, n, new Set())) return true;
    }
  }
  return false;
}

function closureReachable(nodes, pairs, start) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [c, p] of pairs) adj.get(c).push(p);
  let reach = new Set(adj.get(start));
  for (;;) {
    const next = new Set(reach);
    for (const n of reach) {
      for (const m of adj.get(n) || []) next.add(m);
    }
    if (next.size === reach.size) return reach;
    reach = next;
  }
}

test('exhaustive: all edge subsets over <=4 batches cross-checked against independent DFS', () => {
  for (let n = 1; n <= 4; n += 1) {
    const nodes = ['A', 'B', 'C', 'D'].slice(0, n);
    const allPairs = [];
    for (const c of nodes) {
      for (const p of nodes) {
        if (c !== p) allPairs.push([c, p]);
      }
    }
    const total = 1 << allPairs.length;
    for (let mask = 0; mask < total; mask += 1) {
      const pairs = allPairs.filter((_, i) => (mask >> i) & 1);
      const edges = new Map(
        pairs.map(([c, p]) => [`${c} ${p}`, { child: c, parent: p, relation: 'r' }])
      );
      const nodeSet = new Set(nodes);

      assert.equal(
        isDag(nodeSet, edges),
        !independentHasCycle(nodes, pairs),
        `DAG mismatch for n=${n} mask=${mask}`
      );

      for (const start of nodes) {
        const viaDfs = reachableFrom(edges, start);
        const viaClosure = closureReachable(nodes, pairs, start);
        assert.deepEqual(
          [...viaDfs].sort(),
          [...viaClosure].sort(),
          `reachability mismatch for n=${n} mask=${mask} start=${start}`
        );
      }
    }
  }
});
