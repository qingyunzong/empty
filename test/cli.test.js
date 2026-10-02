'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-cli-'));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const GOOD = [
  '{"type":"config","departments":{"root":[],"ops":["root"]},"people":{"a":"ops","b":"ops","c":"root"}}',
  '{"type":"submit","request":"r1","by":"a","dept":"ops","amount":10,"ts":1}',
  '{"type":"approve","request":"r1","by":"b","ts":2}',
  '{"type":"approve","request":"r1","by":"c","ts":3}',
].join('\n') + '\n';

test('CLI writes final.json and exits 0 on valid input', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'events.jsonl');
  const output = path.join(dir, 'final.json');
  fs.writeFileSync(input, GOOD);
  const res = runCli([input, output]);
  assert.equal(res.status, 0, res.stderr);
  const final = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(final.requests.r1.state, 'DISBURSED');
  assert.match(final.audit_hash, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(final.transitions));
  assert.ok(Array.isArray(final.failures));
});

test('CLI exits 1 with stderr on malformed JSON', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'events.jsonl');
  const output = path.join(dir, 'final.json');
  fs.writeFileSync(input, GOOD + '{not json}\n');
  const res = runCli([input, output]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /E_PARSE: line 5/);
  assert.equal(fs.existsSync(output), false);
});

test('CLI exits 1 when first event is not config', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'events.jsonl');
  const output = path.join(dir, 'final.json');
  fs.writeFileSync(input, '{"type":"submit","request":"r1","by":"a","dept":"ops"}\n');
  const res = runCli([input, output]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /E_SCHEMA/);
});

test('CLI exits 1 on missing input file and on bad config', () => {
  const dir = tmpdir();
  const res = runCli([path.join(dir, 'nope.jsonl'), path.join(dir, 'out.json')]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /E_IO/);

  const input = path.join(dir, 'events.jsonl');
  fs.writeFileSync(input, '{"type":"config","departments":{"a":["b"],"b":["a"]},"people":{}}\n');
  const res2 = runCli([input, path.join(dir, 'out.json')]);
  assert.equal(res2.status, 1);
  assert.match(res2.stderr, /E_CONFIG.*cycle/);
});

test('CLI exits 1 without arguments', () => {
  const res = runCli([]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage/);
});
