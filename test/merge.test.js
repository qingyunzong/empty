'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  normalizeGraph,
  mergeGraphs,
  hashGraph,
  GraphFormatError,
} = require('../lib/genealogy');

const CLI = path.join(__dirname, '..', 'index.js');

function norm(raw) {
  return normalizeGraph(raw);
}

function edgeSet(plain) {
  return new Set(plain.edges.map((e) => `${e.child}->${e.parent}:${e.relation}`));
}

test('acceptance 1: disjoint parent-child edges added on both sides merge cleanly', () => {
  const base = norm({ lots: ['A', 'B', 'C', 'D'], edges: [] });
  const local = norm({ lots: ['A', 'B', 'C', 'D'], edges: [{ child: 'C', parent: 'A', relation: 'consumes' }] });
  const remote = norm({ lots: ['A', 'B', 'C', 'D'], edges: [{ child: 'D', parent: 'B', relation: 'transforms' }] });
  const result = mergeGraphs(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.merged.lots, ['A', 'B', 'C', 'D']);
  assert.deepEqual(edgeSet(result.merged), new Set(['C->A:consumes', 'D->B:transforms']));
  assert.equal(result.baseHash, hashGraph(base));
  assert.match(result.baseHash, /^[0-9a-f]{64}$/);
});

test('acceptance 2: same edge deleted on one side and relation-changed on the other conflicts', () => {
  const base = norm({ lots: ['X', 'Y'], edges: [{ child: 'X', parent: 'Y', relation: 'consumes' }] });
  const local = norm({ lots: ['X', 'Y'], edges: [] });
  const remote = norm({ lots: ['X', 'Y'], edges: [{ child: 'X', parent: 'Y', relation: 'transforms' }] });
  const result = mergeGraphs(base, local, remote);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    type: 'edge',
    child: 'X',
    parent: 'Y',
    base: 'consumes',
    local: null,
    remote: 'transforms',
  });
});

test('acceptance 3: individually valid sides forming a directed cycle after merge conflict', () => {
  const base = norm({ lots: ['A', 'B'], edges: [] });
  const local = norm({ lots: ['A', 'B'], edges: [{ child: 'A', parent: 'B', relation: 'feeds' }] });
  const remote = norm({ lots: ['A', 'B'], edges: [{ child: 'B', parent: 'A', relation: 'feeds' }] });
  const result = mergeGraphs(base, local, remote);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].type, 'cycle');
  const cycle = result.conflicts[0].path;
  assert.equal(cycle[0], cycle[cycle.length - 1]);
  assert.equal(cycle.length, 3);
});

test('identical changes on both sides are adopted without conflict', () => {
  const base = norm({ lots: ['A', 'B', 'C'], edges: [{ child: 'A', parent: 'B', relation: 'r1' }] });
  const local = norm({ lots: ['A', 'B', 'C'], edges: [{ child: 'C', parent: 'B', relation: 'r2' }] });
  const remote = norm({ lots: ['A', 'B', 'C'], edges: [{ child: 'C', parent: 'B', relation: 'r2' }] });
  const result = mergeGraphs(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(edgeSet(result.merged), new Set(['C->B:r2']));
});

test('both sides changing the same relation to different values conflicts', () => {
  const base = norm({ lots: ['A', 'B'], edges: [{ child: 'A', parent: 'B', relation: 'r1' }] });
  const local = norm({ lots: ['A', 'B'], edges: [{ child: 'A', parent: 'B', relation: 'r2' }] });
  const remote = norm({ lots: ['A', 'B'], edges: [{ child: 'A', parent: 'B', relation: 'r3' }] });
  const result = mergeGraphs(base, local, remote);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].type, 'edge');
});

test('one side adds an edge, the other removes the parent lot: dangling conflict', () => {
  const base = norm({ lots: ['A', 'B'], edges: [] });
  const local = norm({ lots: ['A'], edges: [] });
  const remote = norm({ lots: ['A', 'B'], edges: [{ child: 'A', parent: 'B', relation: 'r' }] });
  const result = mergeGraphs(base, local, remote);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].type, 'dangling');
  assert.deepEqual(result.conflicts[0].missing, ['B']);
  assert.deepEqual(result.merged.lots, ['A']);
  assert.deepEqual(result.merged.edges, []);
});

test('node removed on one side only is removed in the merge', () => {
  const base = norm({ lots: ['A', 'B'], edges: [] });
  const local = norm({ lots: ['A'], edges: [] });
  const remote = norm({ lots: ['A', 'B'], edges: [] });
  const result = mergeGraphs(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.merged.lots, ['A']);
});

test('normalizeGraph rejects malformed input', () => {
  assert.throws(() => normalizeGraph(null), GraphFormatError);
  assert.throws(() => normalizeGraph({ lots: ['A'] }), GraphFormatError);
  assert.throws(() => normalizeGraph({ lots: ['A', 'A'], edges: [] }), /duplicate lot/);
  assert.throws(
    () => normalizeGraph({ lots: ['A'], edges: [{ child: 'A', parent: 'B', relation: 'r' }] }),
    /unknown lot/,
  );
  assert.throws(
    () => normalizeGraph({ lots: ['A'], edges: [{ child: 'A', parent: 'A', relation: 'r' }] }),
    /self-loop/,
  );
  assert.throws(
    () => normalizeGraph({
      lots: ['A', 'B'],
      edges: [
        { child: 'A', parent: 'B', relation: 'r' },
        { child: 'B', parent: 'A', relation: 'r' },
      ],
    }),
    /cycle/,
  );
});

function runCli(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genealogy-test-'));
  const paths = {};
  for (const [name, content] of Object.entries(files)) {
    paths[name] = path.join(dir, `${name}.json`);
    fs.writeFileSync(paths[name], content);
  }
  paths.out = path.join(dir, 'out.json');
  paths.stderr = path.join(dir, 'stderr.txt');
  // NOTE: this sandboxed environment drops grandchild stderr on pipes, so
  // capture stderr through a file instead of spawnSync's pipe.
  const stderrFd = fs.openSync(paths.stderr, 'w');
  const proc = spawnSync(
    process.execPath,
    [CLI, 'merge-genealogy', '--base', paths.base, '--local', paths.local, '--remote', paths.remote, '--out', paths.out],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', stderrFd] },
  );
  fs.closeSync(stderrFd);
  const stderr = fs.readFileSync(paths.stderr, 'utf8');
  const out = fs.existsSync(paths.out) ? JSON.parse(fs.readFileSync(paths.out, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { proc, out, stderr };
}

const graphJson = (lots, edges) => JSON.stringify({ lots, edges });

test('CLI: clean merge exits 0 and writes merged/conflicts/baseHash', () => {
  const { proc, out } = runCli({
    base: graphJson(['A', 'B', 'C', 'D'], []),
    local: graphJson(['A', 'B', 'C', 'D'], [{ child: 'C', parent: 'A', relation: 'consumes' }]),
    remote: graphJson(['A', 'B', 'C', 'D'], [{ child: 'D', parent: 'B', relation: 'transforms' }]),
  });
  assert.equal(proc.status, 0, proc.stderr);
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.merged.edges.length, 2);
  assert.match(out.baseHash, /^[0-9a-f]{64}$/);
});

test('CLI: conflicting merge exits 1 and still writes the result file', () => {
  const { proc, out } = runCli({
    base: graphJson(['A', 'B'], []),
    local: graphJson(['A', 'B'], [{ child: 'A', parent: 'B', relation: 'feeds' }]),
    remote: graphJson(['A', 'B'], [{ child: 'B', parent: 'A', relation: 'feeds' }]),
  });
  assert.equal(proc.status, 1, proc.stderr);
  assert.equal(out.conflicts.length, 1);
  assert.equal(out.conflicts[0].type, 'cycle');
});

test('CLI: malformed JSON input exits 2', () => {
  const { proc, out, stderr } = runCli({
    base: '{not json',
    local: graphJson(['A'], []),
    remote: graphJson(['A'], []),
  });
  assert.equal(proc.status, 2);
  assert.equal(out, null);
  assert.match(stderr, /invalid JSON/);
});

test('CLI: dangling reference in an input graph exits 2', () => {
  const { proc, out, stderr } = runCli({
    base: graphJson(['A'], []),
    local: graphJson(['A'], [{ child: 'A', parent: 'GHOST', relation: 'r' }]),
    remote: graphJson(['A'], []),
  });
  assert.equal(proc.status, 2);
  assert.equal(out, null);
  assert.match(stderr, /unknown lot/);
});

test('CLI: unknown command exits 2 with usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genealogy-test-'));
  const stderrPath = path.join(dir, 'stderr.txt');
  const stderrFd = fs.openSync(stderrPath, 'w');
  const proc = spawnSync(process.execPath, [CLI, 'nope'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', stderrFd],
  });
  fs.closeSync(stderrFd);
  const stderr = fs.readFileSync(stderrPath, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(proc.status, 2);
  assert.match(stderr, /usage:/);
});
