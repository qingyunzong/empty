import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeLog, makeDir, writeJsonl, runCli } from './helpers.js';

test('verify accepts a well-formed chain', () => {
  const dir = makeDir();
  const log = join(dir, 'log.jsonl');
  writeJsonl(log, makeLog(7));
  const r = runCli(['verify', log]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.events, 7);
  assert.match(out.root, /^[0-9a-f]{64}$/);
});

test('verify rejects tampered hash with exit 9 and locates seq', () => {
  const dir = makeDir();
  const events = makeLog(5);
  events[2].body = { ...events[2].body, amount: 1 };
  const log = join(dir, 'log.jsonl');
  writeJsonl(log, events);
  const r = runCli(['verify', log]);
  assert.equal(r.code, 9, r.stderr);
  assert.match(r.stderr, /seq 3/);
});

test('verify rejects broken prevHash link with exit 9', () => {
  const dir = makeDir();
  const events = makeLog(4);
  events[3].prevHash = '0'.repeat(64);
  const log = join(dir, 'log.jsonl');
  writeJsonl(log, events);
  const r = runCli(['verify', log]);
  assert.equal(r.code, 9);
  assert.match(r.stderr, /seq 4/);
});

test('verify rejects seq gap with exit 9', () => {
  const dir = makeDir();
  const events = makeLog(4);
  events.splice(2, 1); // drop seq 3
  const log = join(dir, 'log.jsonl');
  writeJsonl(log, events);
  const r = runCli(['verify', log]);
  assert.equal(r.code, 9);
});

test('verify rejects non-genesis first prevHash with exit 9', () => {
  const dir = makeDir();
  const events = makeLog(3);
  events[0].prevHash = 'f'.repeat(64);
  const log = join(dir, 'log.jsonl');
  writeJsonl(log, events);
  const r = runCli(['verify', log]);
  assert.equal(r.code, 9);
});
