// CLI tests run in-process (the sandbox forbids child_process spawning):
// invoke runCli directly, capture stderr writes, and assert on the returned
// exit code plus the patch file contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xborder-'));
}

function run(eventsText) {
  const dir = tmpdir();
  const eventsPath = path.join(dir, 'events.jsonl');
  const patchPath = path.join(dir, 'out.jsonl');
  fs.writeFileSync(eventsPath, eventsText);
  let stderr = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderr += chunk;
    return true;
  };
  let code;
  try {
    code = runCli(['run', eventsPath, '--patch', patchPath]);
  } finally {
    process.stderr.write = origWrite;
  }
  const patches = fs.existsSync(patchPath)
    ? fs.readFileSync(patchPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    : null;
  return { code, stderr, patches };
}

test('CLI: happy path writes incremental patches and exits 0', () => {
  const { code, stderr, patches } = run([
    JSON.stringify({ type: 'account', budget: 1000, worstRates: { USD: 2 } }),
    JSON.stringify({ type: 'payment', id: 'p1', amount: 100, ccy: 'USD', rate: null }),
    JSON.stringify({ type: 'freeze', paymentId: 'p1' }),
    JSON.stringify({ type: 'quote', paymentId: 'p1', rate: 1.5, ts: 1 }),
    '',
  ].join('\n'));
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.deepEqual(patches, [{ seq: 1, event: 4, op: 'add', id: 'p1' }]);
});

test('CLI: E_BUDGET exits non-zero with JSON stderr, prior patches kept', () => {
  const { code, stderr, patches } = run([
    JSON.stringify({ type: 'account', budget: 100, worstRates: {} }),
    JSON.stringify({ type: 'payment', id: 'p1', amount: 80, ccy: 'EUR', rate: 1 }),
    JSON.stringify({ type: 'payment', id: 'p2', amount: 50, ccy: 'EUR', rate: 1 }),
    JSON.stringify({ type: 'freeze', paymentId: 'p1' }),
    JSON.stringify({ type: 'freeze', paymentId: 'p2' }),
  ].join('\n'));
  assert.notEqual(code, 0);
  const err = JSON.parse(stderr.trim());
  assert.equal(err.code, 'E_BUDGET');
  assert.equal(typeof err.message, 'string');
  assert.deepEqual(patches, [{ seq: 1, event: 4, op: 'add', id: 'p1' }]);
});

test('CLI: E_RATE_STALE exits non-zero with JSON stderr', () => {
  const { code, stderr } = run([
    JSON.stringify({ type: 'account', budget: 100, worstRates: {} }),
    JSON.stringify({ type: 'payment', id: 'p1', amount: 10, ccy: 'EUR', rate: 1, rateTs: 5 }),
    JSON.stringify({ type: 'quote', paymentId: 'p1', rate: 2, ts: 5 }),
  ].join('\n'));
  assert.notEqual(code, 0);
  const err = JSON.parse(stderr.trim());
  assert.equal(err.code, 'E_RATE_STALE');
  assert.equal(typeof err.message, 'string');
});

test('CLI: usage error exits non-zero', () => {
  let stderr = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  let code;
  try {
    code = runCli([]);
  } finally {
    process.stderr.write = origWrite;
  }
  assert.notEqual(code, 0);
  assert.match(stderr, /usage: xborder run/);
});

test('CLI: real subprocess smoke test (skipped when spawn is not permitted)', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/xborder.js');
  const dir = tmpdir();
  const eventsPath = path.join(dir, 'events.jsonl');
  const patchPath = path.join(dir, 'out.jsonl');
  fs.writeFileSync(eventsPath, JSON.stringify({ type: 'account', budget: 10, worstRates: {} }) + '\n');
  const res = spawnSync(process.execPath, [bin, 'run', eventsPath, '--patch', patchPath], { encoding: 'utf8' });
  if (res.error && res.error.code === 'EPERM') {
    t.skip('child_process spawning not permitted in this environment');
    return;
  }
  assert.equal(res.status, 0, res.stderr);
});
