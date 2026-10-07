import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'route-cli-'));
}

// The sandbox swallows piped stdio of grandchild processes, so capture
// stdout/stderr through files and assert on real output and exit codes.
function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-cli-io-'));
  const outFile = path.join(dir, 'stdout');
  const errFile = path.join(dir, 'stderr');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let status;
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
    status = r.status;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return { status, stdout: fs.readFileSync(outFile, 'utf8'), stderr: fs.readFileSync(errFile, 'utf8') };
}

const GRAPH = {
  devices: [
    { id: 'mill', capacity: 10 },
    { id: 'lathe', capacity: 4 },
  ],
  nodes: [
    { id: 'A', device: 'mill', time: 3, load: 2 },
    { id: 'B', device: 'lathe', time: 2, load: 3 },
    { id: 'C', device: 'mill', time: 5, load: 5 },
    { id: 'D', device: 'mill', time: 1, load: 1 },
  ],
  edges: [
    { from: 'A', to: 'B' },
    { from: 'A', to: 'C' },
    { from: 'B', to: 'D' },
    { from: 'C', to: 'D' },
  ],
};

function writeGraph(dir, obj = GRAPH, name = 'graph.json') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

test('build then query prints the optimal path and exits 0', () => {
  const dir = tmpdir();
  const graphFile = writeGraph(dir);
  const bin = path.join(dir, 'graph.bin');
  let r = run(['build', graphFile, bin, '--chunk-size', '2']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['query', bin, 'A', 'D']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { path: ['A', 'B', 'D'], time: 6 });
});

test('query on a cyclic graph exits 2 and prints E_CYCLE', () => {
  const dir = tmpdir();
  const graphFile = writeGraph(dir, {
    devices: [],
    nodes: [{ id: 'A', time: 1 }, { id: 'B', time: 1 }],
    edges: [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'A' },
    ],
  });
  const bin = path.join(dir, 'cycle.bin');
  assert.equal(run(['build', graphFile, bin]).status, 0);
  const r = run(['query', bin, 'A', 'B']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_CYCLE/);
});

test('query with insufficient capacity exits 2 and prints E_CAPACITY', () => {
  const dir = tmpdir();
  const graphFile = writeGraph(dir, {
    devices: [{ id: 'm', capacity: 1 }],
    nodes: [
      { id: 'A', device: 'm', time: 1, load: 1 },
      { id: 'B', device: 'm', time: 1, load: 1 },
    ],
    edges: [{ from: 'A', to: 'B' }],
  });
  const bin = path.join(dir, 'cap.bin');
  assert.equal(run(['build', graphFile, bin]).status, 0);
  const r = run(['query', bin, 'A', 'B']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_CAPACITY/);
});

test('corrupted block: prefix stays queryable, verify exits 4', () => {
  const dir = tmpdir();
  const graphFile = writeGraph(dir);
  const bin = path.join(dir, 'graph.bin');
  assert.equal(run(['build', graphFile, bin, '--chunk-size', '1']).status, 0);
  const buf = fs.readFileSync(bin);
  buf[buf.length - 10] ^= 0xff;
  fs.writeFileSync(bin, buf);

  const v = run(['verify', bin]);
  assert.equal(v.status, 4);
  assert.match(v.stdout, /CORRUPT block=/);

  const q = run(['query', bin, 'A', 'C']);
  assert.equal(q.status, 0, q.stderr);
  assert.match(q.stderr, /W_CORRUPT/);
  assert.deepEqual(JSON.parse(q.stdout), { path: ['A', 'C'], time: 8 });

  const n = run(['node', bin, 'A']);
  assert.equal(n.status, 0);
  assert.equal(JSON.parse(n.stdout).node.id, 'A');
});

test('commit flow: conflict exits 3 with stable certificate, unrelated commits succeed', () => {
  const dir = tmpdir();
  const storeDir = path.join(dir, 'store');
  assert.equal(run(['init', storeDir]).status, 0);

  const g0 = writeGraph(dir, GRAPH, 'v0.json');
  const r0 = run(['commit', storeDir, '-', g0, '--write', '']);
  assert.equal(r0.status, 0, r0.stderr);
  const base = r0.stdout.trim();
  assert.ok(base.length === 64);

  const g1 = writeGraph(dir, { ...GRAPH, nodes: [...GRAPH.nodes, { id: 'E', device: 'mill', time: 2, load: 1 }] }, 'v1.json');
  const r1 = run(['commit', storeDir, base, g1, '--read', 'B', '--write', 'B']);
  assert.equal(r1.status, 0, r1.stderr);
  const v1 = r1.stdout.trim();

  const g2 = writeGraph(dir, { ...GRAPH, nodes: [...GRAPH.nodes, { id: 'F', device: 'mill', time: 2, load: 1 }] }, 'v2.json');
  const conflict = run(['commit', storeDir, base, g2, '--read', 'B,C', '--write', 'C']);
  assert.equal(conflict.status, 3);
  const cert = JSON.parse(conflict.stdout);
  assert.equal(cert.error, 'E_CONFLICT');
  assert.equal(cert.baseHash, base);
  assert.equal(cert.theirHash, v1);
  assert.deepEqual(cert.readSet, ['B', 'C']);
  assert.equal(cert.commonAncestor, base);

  const conflict2 = run(['commit', storeDir, base, g2, '--read', 'B,C', '--write', 'C']);
  assert.equal(conflict2.status, 3);
  assert.deepEqual(JSON.parse(conflict2.stdout), cert);

  const ok = run(['commit', storeDir, v1, g2, '--read', 'D', '--write', 'D']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.stdout.trim().length === 64);

  const log = run(['log', storeDir]);
  assert.equal(log.status, 0);
  assert.equal(log.stdout.trim().split('\n').length, 3);
});

test('no arguments prints usage and exits 1', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
});
