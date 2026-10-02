import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = new URL('../bin/risk.js', import.meta.url).pathname;
// Note: piped stdio is not reliably captured in this sandbox, so the child
// writes to temp files instead.
let tmpCount = 0;
const run = (args) => {
  const dir = mkdtempSync(join(tmpdir(), `risk-cli-${process.pid}-${tmpCount++}-`));
  const outPath = join(dir, 'out.txt');
  const errPath = join(dir, 'err.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [BIN, ...args], { stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: r.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
};

test('risk check accepts the example rule files', () => {
  const r = run(['check', 'examples/rules.rsk', 'examples/rules-v2.rsk']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('risk check rejects override violations with exit 2 and E_OVERRIDE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-'));
  const bad = join(dir, 'bad.rsk');
  writeFileSync(bad, `version 1
rule g level global { deny when amount > 100CNY }
rule m level merchant match merchant M1 { deny when amount > 200CNY }
`);
  const r = run(['check', bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_OVERRIDE/);
});

test('risk eval emits one JSON per event; --explain adds trace', () => {
  const r = run(['eval', 'examples/rules.rsk', 'examples/events.jsonl', '--explain']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 4);
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.equal(byId.e1.outcome, 'deny');
  assert.deepEqual(byId.e1.matched.map((m) => m.rule), ['c_payx']);
  assert.equal(byId.e2.outcome, 'deny');
  assert.equal(byId.e4.outcome, 'review'); // pending review is not a pass
  assert.ok(byId.e1.explain.overrides.length >= 1); // override audit trail present
  assert.ok(lines.every((l) => l.version === 1));
});

test('hot update: later events use v2, old events replay under v1', () => {
  const r = run(['eval', 'examples/rules.rsk', 'examples/rules-v2.rsk', 'examples/events.jsonl']);
  assert.equal(r.status, 0, r.stderr);
  const byId = Object.fromEntries(
    r.stdout.trim().split('\n').map(JSON.parse).map((l) => [l.id, l]));
  assert.equal(byId.e1.version, 1);
  assert.equal(byId.e3.version, 2);
  assert.equal(byId.e3.outcome, 'deny');
});

test('eval without --explain omits the trace', () => {
  const r = run(['eval', 'examples/rules.rsk', 'examples/events.jsonl']);
  assert.equal(r.status, 0, r.stderr);
  const first = JSON.parse(r.stdout.trim().split('\n')[0]);
  assert.equal(first.explain, undefined);
});
