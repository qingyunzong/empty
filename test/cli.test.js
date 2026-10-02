import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, openSync, readFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'linearize.js');

// The sandbox swallows piped stdout of grandchild processes, so capture
// stdout via a temp file instead of a pipe.
function run(args) {
  const dir = mkdtempSync(path.join(tmpdir(), 'linearize-test-'));
  const outFile = path.join(dir, 'out.txt');
  const fd = openSync(outFile, 'w');
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', fd, 'pipe'],
  });
  closeSync(fd);
  return { code: result.status, stdout: readFileSync(outFile, 'utf8'), stderr: result.stderr };
}

test('linearize reports a witness with audit values', () => {
  const { code, stdout } = run(['linearize', path.join(root, 'examples', 'partial-capture-cancel.json')]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'LINEARIZABLE');
  assert.deepEqual(out.witness.order, ['h1', 'c1', 'x1', 'a1']);
  assert.equal(out.witness.allocations.c1, 30);
  assert.deepEqual(out.witness.audits.a1, { frozen: 0, captured: 30, available: 0 });
});

test('linearize accepts overlapping audits reading different states', () => {
  const { code, stdout } = run(['linearize', path.join(root, 'examples', 'overlapping-audits.json')]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'LINEARIZABLE');
  assert.deepEqual(out.witness.audits.a1, { frozen: 100, captured: 0, available: 100 });
  assert.deepEqual(out.witness.audits.a2, { frozen: 60, captured: 40, available: 60 });
});

test('linearize reports a minimal conflict set', () => {
  const { code, stdout } = run(['linearize', path.join(root, 'examples', 'capture-after-cancel.json')]);
  assert.equal(code, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'NOT_LINEARIZABLE');
  assert.ok(out.conflict.includes('x1'));
  assert.ok(out.conflict.includes('c1'));
});

test('linearize rejects invalid histories with INVALID_HISTORY', () => {
  const { code, stdout } = run(['linearize', path.join(root, 'examples', 'invalid-negative-capture.json')]);
  assert.equal(code, 2);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'INVALID_HISTORY');
  assert.ok(out.errors.some((e) => e.includes('negative capture')));
});

test('linearize rejects unparseable input and bad usage', () => {
  const missing = run(['linearize', path.join(root, 'examples', 'does-not-exist.json')]);
  assert.equal(missing.code, 2);
  assert.equal(JSON.parse(missing.stdout).status, 'INVALID_HISTORY');
  const usage = run([]);
  assert.equal(usage.code, 2);
});
