'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeEvents, tmpdir, writeLog, runCli } = require('./helpers');

test('verify: valid log passes with exit 0 and prints root', async () => {
  const dir = tmpdir();
  const log = writeLog(dir, 'log.jsonl', makeEvents(10));
  const res = await runCli(['verify', log]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^OK events=10 root=[0-9a-f]{64}\n$/);
});

test('verify: tampered hash is rejected with exit 9', async () => {
  const dir = tmpdir();
  const events = makeEvents(5);
  events[2].hash = 'f'.repeat(64);
  const log = writeLog(dir, 'log.jsonl', events);
  const res = await runCli(['verify', log]);
  assert.equal(res.status, 9);
  assert.match(res.stderr, /seq 3/);
});

test('verify: broken prevHash linkage is rejected with exit 9', async () => {
  const dir = tmpdir();
  const events = makeEvents(5);
  events[3].prevHash = 'a'.repeat(64);
  const log = writeLog(dir, 'log.jsonl', events);
  const res = await runCli(['verify', log]);
  assert.equal(res.status, 9);
  assert.match(res.stderr, /broken chain at seq 4/);
});

test('verify: tampered body (hash not recomputed) is rejected with exit 9', async () => {
  const dir = tmpdir();
  const events = makeEvents(5);
  events[1].body = { amount: 1 };
  const log = writeLog(dir, 'log.jsonl', events);
  const res = await runCli(['verify', log]);
  assert.equal(res.status, 9);
  assert.match(res.stderr, /hash mismatch at seq 2/);
});

test('verify: seq gap is rejected with exit 9', async () => {
  const dir = tmpdir();
  const events = makeEvents(5);
  events[3].seq = 40;
  const log = writeLog(dir, 'log.jsonl', events);
  const res = await runCli(['verify', log]);
  assert.equal(res.status, 9);
  assert.match(res.stderr, /seq discontinuity/);
});

test('verify: invalid JSON line is rejected with exit 9', async () => {
  const dir = tmpdir();
  const log = writeLog(dir, 'log.jsonl', makeEvents(3));
  fs.appendFileSync(log, 'not-json\n');
  const res = await runCli(['verify', log]);
  assert.equal(res.status, 9);
});
