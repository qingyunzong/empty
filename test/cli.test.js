import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

const SPEC = `
account A {
  capacity 10
  strategy s1 { quota 10 }
}`;

function makeStreams() {
  const out = { text: '', write(s) { this.text += s; } };
  const err = { text: '', write(s) { this.text += s; } };
  return { out, err };
}

function cli(args) {
  const { out, err } = makeStreams();
  const status = main(args, out, err);
  return { status, stdout: out.text, stderr: err.text };
}

function withFiles(spec, history) {
  const dir = mkdtempSync(join(tmpdir(), 'limit-'));
  const specPath = join(dir, 'spec.lim');
  const histPath = join(dir, 'history.json');
  writeFileSync(specPath, spec);
  writeFileSync(histPath, JSON.stringify(history));
  return { specPath, histPath };
}

test('CLI: linearizable history exits 0 and prints orders', () => {
  const { specPath, histPath } = withFiles(SPEC, [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 4, invoke: 0, response: 1, result: 'ok' },
  ]);
  const r = cli(['check', specPath, histPath, '--max', '8']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /status: OK/);
  assert.match(r.stdout, /linearizations: 1/);
  assert.match(r.stdout, /^r1$/m);
});

test('CLI: pending history exits 3 (E_PENDING) without rejecting', () => {
  const { specPath, histPath } = withFiles(SPEC, [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 8, invoke: 0, response: 5, result: 'ok' },
    { id: 'r2', kind: 'reserve', account: 'A', strategy: 's1', amount: 8, invoke: 1, response: null, result: 'pending' },
  ]);
  const r = cli(['check', specPath, histPath]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /status: PENDING/);
  assert.match(r.stdout, /not treated as failure/);
});

test('CLI: non-linearizable history exits 2 (E_LINEAR)', () => {
  const { specPath, histPath } = withFiles(SPEC, [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 6, invoke: 0, response: 2, result: 'ok' },
    { id: 'r2', kind: 'reserve', account: 'A', strategy: 's1', amount: 6, invoke: 3, response: 5, result: 'ok' },
  ]);
  const r = cli(['check', specPath, histPath]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /status: E_LINEAR/);
});

test('CLI: over-bound history exits 4 (E_BOUND)', () => {
  const ops = Array.from({ length: 9 }, (_, i) => ({
    id: `r${i}`, kind: 'reserve', account: 'A', strategy: 's1', amount: 1,
    invoke: i, response: i + 1, result: 'ok',
  }));
  const { specPath, histPath } = withFiles(SPEC, ops);
  const r = cli(['check', specPath, histPath, '--max', '8']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /E_BOUND/);
});

test('CLI: duplicate release exits 5 (E_TYPE)', () => {
  const { specPath, histPath } = withFiles(SPEC, [
    { id: 'r1', kind: 'reserve', account: 'A', strategy: 's1', amount: 3, invoke: 0, response: 1, result: 'ok' },
    { id: 'x1', kind: 'release', target: 'r1', invoke: 2, response: 3, result: 'ok' },
    { id: 'x2', kind: 'release', target: 'r1', invoke: 4, response: 5, result: 'fail' },
  ]);
  const r = cli(['check', specPath, histPath]);
  assert.equal(r.status, 5);
  assert.match(r.stderr, /E_TYPE.*duplicate release/);
});

test('CLI: usage error exits 1', () => {
  const r = cli(['check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: limit check/);
});
