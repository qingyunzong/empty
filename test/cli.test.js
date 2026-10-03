import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const risk = path.join(root, 'bin', 'risk.js');
const rules = path.join(root, 'examples', 'rules.rsk');
const events = path.join(root, 'examples', 'events.jsonl');

// The sandbox swallows child-process pipes, so capture via temp files.
function run(args) {
  const dir = mkdtempSync(path.join(tmpdir(), 'risk-cli-'));
  const outPath = path.join(dir, 'out.txt');
  const errPath = path.join(dir, 'err.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [risk, ...args], { stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  const result = {
    status: r.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test('risk eval emits one JSON decision per event', () => {
  const r = run(['eval', rules, events]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.equal(lines[0].decision, 'DENY');
  assert.deepEqual(lines[0].rules, [
    'global/channel("alipay")/a_amount',
    'global/channel("alipay")/merchant("MCH000001")/m_amount',
    'global/g_amount',
  ]);
  assert.equal(lines[1].decision, 'REVIEW');
  assert.equal(lines[2].decision, 'REVIEW');
  assert.equal(lines[3].version, 'v2');
});

test('risk eval --explain prints the decision trace', () => {
  const r = run(['eval', rules, events, '--explain']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /event=e1 .* version=v1 decision=DENY/);
  assert.match(r.stdout, /strictest:/);
  assert.match(r.stdout, /overrides:/);
});

test('risk check compiles and reports overrides', () => {
  const r = run(['check', rules]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /version v1/);
  assert.match(r.stdout, /override global\/channel\("alipay"\)/);
  assert.match(r.stdout, /OK/);
});

test('compile errors exit non-zero with the error code', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'risk-bad-'));
  const bad = path.join(dir, 'bad.rsk');
  writeFileSync(
    bad,
    `version "v1" since "2024-01-01T00:00:00Z" {
  scope global {
    threshold max_amount: money = 100.00;
    scope channel("alipay") {
      threshold max_amount: money = 200.00;
    }
  }
}`,
  );
  try {
    const r = run(['check', bad]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^E_OVERRIDE:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
