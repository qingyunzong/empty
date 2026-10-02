'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agv-chain-'));
}

test('CLI writes a certificate and exits 0', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'ev.jsonl');
  const cert = path.join(dir, 'c.json');
  fs.writeFileSync(input, [
    '{"type":"ASSIGN","job":"A","leg":0,"seq":1,"causes":[],"ts":100}',
    '{"type":"PICK","job":"A","leg":0,"seq":2,"causes":[],"ts":200}',
    // fragmented frame across two lines:
    '{"type":"DROP","job":"A","leg":0,',
    '"seq":3,"causes":[],"ts":300}',
    // duplicate of the first event:
    '{"type":"ASSIGN","job":"A","leg":0,"seq":1,"causes":[],"ts":100}',
    '',
  ].join('\n'));
  const r = run([input, '--cert', cert]);
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(fs.readFileSync(cert, 'utf8'));
  assert.equal(c.eventCount, 3);
  assert.equal(c.duplicateCount, 1);
  assert.match(c.chainHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(c.staleLog, []);
});

test('CLI exits 14 on causes cycle and writes no certificate', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'ev.jsonl');
  const cert = path.join(dir, 'c.json');
  fs.writeFileSync(input, [
    '{"type":"ASSIGN","job":"A","leg":0,"seq":1,"causes":[{"job":"B","leg":0}],"ts":1}',
    '{"type":"ASSIGN","job":"B","leg":0,"seq":1,"causes":["A:0"],"ts":2}',
    '',
  ].join('\n'));
  const r = run([input, '--cert', cert]);
  assert.equal(r.status, 14, r.stderr);
  assert.match(r.stderr, /ERR_CAUSES_CYCLE/);
  assert.equal(fs.existsSync(cert), false);
});

test('CLI exits 15 on illegal RETRY', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'ev.jsonl');
  const cert = path.join(dir, 'c.json');
  fs.writeFileSync(input, [
    '{"type":"ASSIGN","job":"A","leg":0,"seq":1,"causes":[],"ts":1}',
    '{"type":"PICK","job":"A","leg":0,"seq":2,"causes":[],"ts":2}',
    '{"type":"RETRY","job":"A","leg":1,"seq":3,"causes":[],"ts":3}',
    '',
  ].join('\n'));
  const r = run([input, '--cert', cert]);
  assert.equal(r.status, 15, r.stderr);
  assert.match(r.stderr, /ERR_ILLEGAL_RETRY/);
  assert.equal(fs.existsSync(cert), false);
});

test('CLI prints certificate to stdout without --cert', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'ev.jsonl');
  fs.writeFileSync(input, '{"type":"ASSIGN","job":"A","leg":0,"seq":1,"causes":[],"ts":1}\n');
  const r = run([input]);
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.equal(c.jobCount, 1);
});
