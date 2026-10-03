import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = new URL('../cli.mjs', import.meta.url).pathname;

// The sandbox disallows pipes between processes, so capture stdout through a
// temporary file instead of execFileSync's pipe.
function run(args) {
  const outPath = join(mkdtempSync(join(tmpdir(), 'cliout-')), 'out.json');
  const fd = openSync(outPath, 'w');
  let status;
  try {
    const r = spawnSync('node', [CLI, ...args], { stdio: ['ignore', fd, 'ignore'] });
    if (r.error) throw r.error;
    status = r.status;
  } finally {
    closeSync(fd);
  }
  return { code: status, out: JSON.parse(readFileSync(outPath, 'utf8')) };
}

function fixture(dir, name, obj) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const INSTANCE = {
  machines: 2,
  memoryLimit: 4,
  steps: [
    { id: 'a', params: ['x', 'y'], memory: 1, duration: 2 },
    { id: 'b', params: ['u'], memory: 2, duration: 1 },
  ],
  edges: [['a', 'b']],
  compat: [],
};

test('CLI: solve writes a certificate that verify accepts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-'));
  const inst = fixture(dir, 'inst.json', INSTANCE);
  const cert = join(dir, 'cert.json');
  const r = run(['solve', inst, '--cert', cert]);
  assert.equal(r.code, 0);
  assert.equal(r.out.status, 'SAT');
  const v = run(['verify', cert]);
  assert.equal(v.code, 0);
  assert.equal(v.out.status, 'VALID');
});

test('CLI: invalid instance yields INVALID_INPUT error JSON with exit code 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-'));
  const inst = fixture(dir, 'bad.json', { machines: 0, memoryLimit: -1, steps: [] });
  const r = run(['solve', inst]);
  assert.equal(r.code, 1);
  assert.equal(r.out.status, 'INVALID_INPUT');
  assert.ok(Array.isArray(r.out.details));
});

test('CLI: UNSAT exits with code 2 and status UNSAT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-'));
  const inst = fixture(dir, 'unsat.json', {
    machines: 1,
    memoryLimit: 1,
    steps: [{ id: 'a', params: ['x'], memory: 5, duration: 1 }],
  });
  const r = run(['solve', inst]);
  assert.equal(r.code, 2);
  assert.equal(r.out.status, 'UNSAT');
});

test('CLI: node budget exhaustion exits 3 with PENDING', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-'));
  const inst = fixture(dir, 'inst.json', INSTANCE);
  const r = run(['solve', inst, '--max-nodes', '1']);
  assert.equal(r.code, 3);
  assert.equal(r.out.status, 'PENDING');
});

test('CLI: tampered certificate verify exits 5 with INVALID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-'));
  const inst = fixture(dir, 'inst.json', INSTANCE);
  const cert = join(dir, 'cert.json');
  run(['solve', inst, '--cert', cert]);
  const obj = JSON.parse(readFileSync(cert, 'utf8'));
  obj.entries[1].entry.type = 'corrupted';
  writeFileSync(cert, JSON.stringify(obj));
  const v = run(['verify', cert]);
  assert.equal(v.code, 5);
  assert.equal(v.out.status, 'INVALID');
});

test('CLI: stateful pin/unpin and checkpoint CONFLICT flow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-'));
  const inst = fixture(dir, 'inst.json', INSTANCE);
  const state = join(dir, 'state.json');
  assert.equal(run(['init', state, inst]).out.status, 'INIT');
  assert.equal(run(['fork-checkpoint', state, 'cp1']).out.status, 'FORKED');
  const p1 = run(['pin', state, 'a', 'x']);
  assert.equal(p1.out.status, 'SAT');
  assert.equal(run(['fork-checkpoint', state, 'branchA']).out.status, 'FORKED');
  assert.equal(run(['restore-checkpoint', state, 'cp1']).out.status, 'RESTORED');
  run(['pin', state, 'a', 'y']);
  const m = run(['merge-checkpoint', state, 'branchA']);
  assert.equal(m.code, 4);
  assert.equal(m.out.status, 'CONFLICT');
  assert.ok(m.out.details.divergence.edge.current.hash !== m.out.details.divergence.edge.checkpoint.hash);
  // unpin returns to the unpinned optimum.
  const u = run(['unpin', state, 'a']);
  assert.equal(u.out.status, 'SAT');
  const fresh = run(['solve', inst]);
  assert.deepEqual(u.out.plan, fresh.out.plan);
});

test('CLI: unknown command yields INVALID_INPUT', () => {
  const r = run(['frobnicate']);
  assert.equal(r.code, 1);
  assert.equal(r.out.status, 'INVALID_INPUT');
});
